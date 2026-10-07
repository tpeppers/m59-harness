# World-tour movement quality review, 2026-10-06

Arrival speed and survival are evaluated together, including unfinished and refused trips. The fresh comparison uses six 15-minute checkpoint-ring trials restored from one starting save with 21 expendable lab characters. A timed tour does not imply every character completed a full circuit or visited every map.

## Fresh comparison

| Trial (15 minutes) | Arrivals | Audited deaths | Median s | Completed p90 s | Open older than own p90 | Open older than baseline p90 | All-attempt p90 lower bound s | Legs/actor-hour |
|---|---|---|---|---|---|---|---|---|
| forward-baseline | 55 | 1 | 161.0 | 374.0 | 10 | 10 | 596.7 | 10.44 |
| forward-fixed-v2 | 64 | 0 | 158.7 | 443.3 | 3 | 8 | 471.6 | 12.16 |
| forward-fixed-v4 | 60 | 1 | 152.3 | 346.3 | 13 | 13 | 444.1 | 11.39 |
| reverse-baseline | 56 | 1 | 127.6 | 560.6 | 7 | 7 | 705.1 | 10.62 |
| reverse-fixed-v2 | 72 | 2 | 133.7 | 370.0 | 9 | 5 | 505.3 | 13.71 |
| reverse-fixed-v4 | 67 | 2 | 151.1 | 433.8 | 5 | 3 | 463.1 | 12.75 |

Every cycling character has an open leg at the bell. The common baseline-p90 column uses the same age cutoff within each direction: forward 374.035 seconds, reverse 560.622 seconds. V2 open-trip counts at these common cutoffs are 10→8 forward and 7→5 reverse; counts against each run’s own p90 use a changing cutoff and cannot be compared alone. Recently dispatched trips differ from old stalls; the age column separates them. Completed-trip p90 excludes unfinished attempts. The machine-readable report retains their ages and explicitly labels the all-attempt duration percentile as a lower bound. Refused dispatches stop aging at refusal. Death counts are checked against postmortem event times.

Intermediate V2 forward: 55→64 arrivals (+16%), 1→0 audited deaths, and 10→3 open trips older than the completed p90. All 21 characters arrived at least once, versus 19 in baseline. Jasper→Castle completed p90 improved 690→479 seconds; aggregate completed p90 rose 374→443 seconds as more long legs finished. Several individual checkpoint pairs were slower. This supports better completion in this trial, not a uniform speedup or a statistically established death reduction.

Intermediate V2 reverse: 56→72 arrivals, 1→2 audited deaths, completed p90 560.6→370.0 seconds, and 7→9 old open trips. Together the trials completed 111→136 legs (+23%), with two audited deaths in each bundle. Survival improvement is not established. One run per direction is still vulnerable to timing and monster-contact variation.

Final V4 bundle: 111→127 completed legs (+14.4%), audited deaths 2→3. Each direction is reported independently in the table; aggregate improvement must not hide a directional regression. These are single-run observations, not a causal survival estimate.

## Historic comparison

| Saved trial | Direction | Minutes | Arrivals | Audited deaths | Completed p90 s | Open older than p90 |
|---|---|---|---|---|---|---|
| hour-20260916 | forward | 60 | 193 | 2 | 686.7 | 7 |
| tour-sim | reverse | 15 | 92 | 0 | 299.1 | 4 |
| survival-tour-20260922 | reverse | 60 | 53 | 12 | 1015.5 | 20 |
| survival-jam-tour-20260922 | reverse | 60 | 160 | 8 | 610.9 | 9 |
| survival-retreat-tour-20260922 | reverse | 60 | 84 | 1 | 636.5 | 20 |
| survival-traffic-tour-20260923 | reverse | 60 | 77 | 22 | 820.9 | 16 |

The latest one-hour reverse traffic tour had 22 monster deaths: 15 in Sewers 108, five in Flatlands 584, one in Cragged Mountains 598 and one in Badlands border 585. Its predecessor had one death and 84 legs; the traffic tour had 77 legs and 22 deaths. Different inventories, max health, saved worlds and timing prevent attributing that increase to one code regression. The historic jam tour undercounted a death in its polled result.

The September 16 forward report describes an experimental fix for weapon-creation waits during suspended travel. That behavior is absent from current main. This establishes a recurring problem and an unlanded historical proposal; it does not establish when or why a committed fix was reverted.

## Slow checkpoint pairs

Room numbers: 52 Tos inn, 106 Barloque inn, 153 Cor Noth inn, 202 Marion inn, 370 Jasper inn, 39 upstairs in Castle Victoria, 110 Barloque shadowy corner. Parentheses give completed sample counts. Castle 39→110 is a checkpoint leg, not a direct Castle→Barloque-inn 106 benchmark.

| Direction | From→to | Baseline completed p90 s (n) | Fixed completed p90 s (n) | Open at bell baseline / fixed |
|---|---|---|---|---|
| forward | 106>153 | 136.7 (8) | 132.9 (9) | 0 / 0 |
| forward | 110>52 | 161.0 (1) | 211.9 (1) | 1 / 1 |
| forward | 153>202 | 96.4 (12) | 148.7 (13) | 0 / 0 |
| forward | 202>370 | 217.9 (16) | 219.7 (17) | 0 / 0 |
| forward | 370>39 | 690.0 (12) | 386.1 (13) | 8 / 8 |
| forward | 39>110 | 365.0 (2) | 373.9 (2) | 10 / 11 |
| forward | 52>106 | 96.6 (4) | 119.1 (5) | 2 / 1 |
| reverse | 106>52 | 315.7 (13) | 180.3 (16) | 2 / 0 |
| reverse | 110>39 | 452.0 (3) | 484.8 (6) | 9 / 9 |
| reverse | 153>106 | 78.4 (11) | 94.1 (12) | 1 / 1 |
| reverse | 202>153 | 217.9 (8) | 220.5 (9) | 2 / 1 |
| reverse | 370>202 | 164.1 (6) | 198.3 (6) | 1 / 1 |
| reverse | 39>370 | 182.2 (3) | 299.4 (3) | 0 / 3 |
| reverse | 52>110 | 746.5 (12) | 509.2 (15) | 6 / 6 |

The forward baseline's Jasper→Castle p90 was 690 seconds, with eight more attempts unfinished. Its aggregate completed p90 was only 374 seconds. An aggregate alone hides that road. Forward accumulated approximately 51 character-minutes in Ukgoth and 69 character-minutes holding safe spots across all rooms. Reverse accumulated about 64 character-minutes in Flatlands and 49 each in Badlands and Sewers. These coarse room-exposure estimates include recovery and inactivity, not just blocked movement.

## Fixes tested

- **Separate entry coordinate frames.** `enteredVia.door` belongs to the source map and remains necessary for selecting a return doorway. Recovery incorrectly used it as a goal in the destination map. Historic traffic records contain 35 retreat events with entry goals outside that grid or without floor. Local retreat now uses an observed destination-map `landing`; missing or stale landing memory skips that local rung and preserves the return-room fallback. The entry packet often precedes self position, so capture also runs after room contents settle, before the between-room hook.
- **Retain the travel arming guard during recovery.** Walking unarmed is normally allowed on a journey, but suspending it could block recovery on weapon creation, including unusable or banned weapons. A healthy baseline Jasper traveler spent several minutes in that loop. Suspended travel now bypasses the factory when its original guard permits it. Explicit per-order arming requirements are copied at suspension and restored on resume; health, cover, ownership and death-recovery gates still apply.
- **Preserve Underworld escape ownership.** A stage deadline abandons the ladder's wait, not its work. An unfinished portal escape now retains the dead body on subsequent passes, preventing ordinary arming or resting underneath it. Stage ages, deadlines, overruns and skipped calls are exported.
- **Try other portals after a missed shifting window.** A silent preferred-city portal failure followed by a failed shifting-portal step returned immediately, without trying remaining fixed portals. The routine now falls through in the same escape. The baseline forward death spent almost twelve character-minutes in the Underworld, with a reported failure matching this branch. The focused test fails on original code and succeeds through an alternate portal on the fix.
- **Keep routine monster maps eligible.** The global transit preference against Deep Woods 534 is removed. Ukgoth 599 and Cragged Mountains 598 remain routable. The timed Temple of Qor preference and existing explicit puzzle/operator exclusions remain. Physical reachability and live-body collision checks still govern routing.

Coordinate, unarmed-recovery and portal cases fail against unchanged code and pass with the fixes. Two interrupted pilots are retained separately and excluded from full-window comparisons: a five-minute landing-capture pilot, and a two-minute V3 pilot stopped after a Windows source-encoding error was found and corrected before V4. Its landing telemetry exposed the late-position packet gap: initially 16 of 141 distinct entry memories observed by the sampler had landings. Refining capture raised early observed coverage to 279 of 281; this is a sample of entry memories, not a census of every crossing.

## Source-proven portal identity (additional change)

The five fixed Underworld portal destinations and their squares are paired in `uworld.kod:649–662`. `ResetPuzzle` and brazier `SetAnimation` only change availability; `portal.kod` retains the destination set by its constructor. Missing or unlit wording therefore does not imply an unknown destination. Room 1 plus the native fixed portal square identifies its city, with an `identity_source` recorded in the escape result. The rip occupies a separate square and still requires a fresh destination reading; a named rip is excluded from fixed-square inference.

This identification change was added after V2. It is **not included in the V2 measured source bundle** and is included in the final V4 trials. All five missing-description cases and a two-portal wrong-inn case pass offline, along with tests rejecting another room and a named rip. Native wire observations and maintenance reads verified all five inferred inn numbers against live `Portal.piDest_room`, including one inactive portal, with zero LOOK requests. Object positions preserve the source NewHold indices; the old `clientRow/clientCol` subtraction was one square off. New `objectRow/objectCol` fields drive inference and sorting; the legacy hints remain exported. A separate native escape walk stalled and was interrupted, so this verifies identity, not successful Underworld pathing.

## Exit refuge progress guard (additional change)

The two intermediate V2 reverse deaths exposed a branch missing the existing recovery progress guard. Wall approaches track confirmed shorter routes; exit-as-refuge approaches previously called `travel` without that watch. Exit refuge attempts now use the same eight-second confirmed-progress memory, scope, cancellation and cleanup rules during travel/recovery. The focused blocked-crossing test fails with this branch unchanged and passes on the fix; successful crossing clears its timer. This additional fix is **not included in the paired V2 tour metrics** and is included in the final V4 trials. Neither recorded death is declared saved by it. The native V4 forward trial observed the guard cancel an exit approach in Twisted Wood 597 after 8.535 seconds without health loss; that character was later observed in Ukgoth 599 with the same Castle objective retained. This verifies firing and continued movement, not that a death was prevented. The final V4 tours test the whole bundle; a native matched congestion replay would still be needed to attribute an individual saved death to this guard.

## Remaining problems

The final V4 forward trial recorded an orc death in room 579 at r48c34. The bot reached its selected wall at 25/43 health, entered `logoff_safe`, and that decision lasted about 164 seconds before returning with critically low health. It then attempted the exit and died within a second. A wall classified as safe did not establish survival during that logged-off interval. Coverage should be attested against the current attacker and its attack order; shorter verification/rejoin intervals and alternate cover are avenues for a dedicated native replay. No new safe-wall policy is declared validated by this trial.

The intermediate V2 reverse trial recorded a spider death in Flatlands 584 at r35c32. The active survival decision targeted the onward exit at r35c37, three planned steps from selection, but remained active about 45 seconds until death. Multiple fleet characters and monsters occupied the corridor. A second spider death at r35c28 held an exit-as-refuge decision for about 83 seconds without crossing. These are congestion and recovery execution failures; the short-route case differs from the distant-refuge problem below. The watchdog reported no interrupt. Its inherited pinned timeout is exceptionally large, and the existing low-health travel cancellation arm is also explicitly disabled in source. This review does not attribute the outcome solely to the timeout or claim that restoring the ordinary setting would prevent these deaths.


The final V4 reverse deaths were different failures: a troll killed Iiii in Ukgoth 599 at r23c33 and a lupogg killed Tttt in Sewers 108 at r35c38. Iiii selected a wall at r19c30 from one planned step away at 32/50 health; live congestion prevented arrival, and within about five seconds health fell to 6. Recovery replanned to the same wall by a six-step route, then died before arrival. Tttt repeatedly exhausted refuge alternatives at r35c38 while health fell from 27/45 to 1; the recorded reason reported 54 walls considered, one reachable, and no defensible choice. A live body shared the character's square in the snapshots. These deserve local overlap escape and health-budgeted refuge selection, rather than a categorical map ban. The snapshot threat list did not identify the broadcast killer reliably, so use the death broadcast for attribution.

Both V2 Flatlands victims remained alive in final V4, but Dddd still had a roughly 790-second open leg in room 584 and Rrrr a roughly 453-second open leg ending in 585. Changed monster contact and stalled arrival preclude declaring either saved by the guard. Forward V4 old open trips increased 10 to 13 at the fixed baseline age cutoff, despite a lower completed p90. Reverse fell 7 to 3. The final bundle improves measured throughput, but does not dominate baseline on every quality measure.

The fresh baseline deaths and the interrupted pilot death selected the same Badlands refuge at r44c10 from 17–25 planned squares away. One baseline died after roughly seven seconds of approach; the pilot died after thirteen. A geometrically reachable refuge may be too far for the remaining health. Route-relative progress, estimated refuge arrival time versus time-to-death, and short exit/breadcrumb alternatives deserve a matched follow-up. A far refuge is not universally wrong; displacement alone does not establish useful escape progress.

Long stops can be a real collision, useful healing, a portal lookup, or unfinished concurrent work. New telemetry records stage flight age, landing coordinates, snapshot age/generation and broker loop lag. The private controller preserves stationary/critical scenes, initial/final states, route samples, collision traces, decision histories, postmortems, checksummed replay bundles and complete before/after native saves. A healthy character holding cover is not automatically a pathing stall.

Forward fixed telemetry captured local landing memory for 561 of 563 unique entries sampled in keeper states. This is sampled coverage, not a census of every crossing.

## Boundaries and verification

- Behavior baseline: main `5e25b70b82f2ebd56d9e49adbec02013a3d09b06`. Baseline game, autopilot, map, world, walking, watchdog and skills file hashes match exactly. Aggregate hashes differ only because offline reporting tools were added between baseline runs. The forward/reverse V2 arms share one movement bundle; all 1,352 captured source-file hashes match between the V4 arms, which share the final bundle with portal identity and exit refuge progress. No behavioral files change during either pair.
- Each arm restores the same verified native save and private roster, uses itinerary seed 22, and starts a fresh learning scope. Missing seed books remain missing equally; the bad-exit seed is copied. Learning never carries from baseline to fixed.
- The restored world includes historic traffic bodies and ordinary active monster timers. Monsters are not immobilized or quieted during tours. `show simseed` confirms an unpatched image: the stock random stream restarts on boot, but global draw order changes with timing and concurrency. These are not bit-exact paired replays.
- Existing tour preparation restores health and mana; vigor is inherited from the saved world. Monster timer phase, startup-to-launch delay, host load and first-leg preparation remain confounders. Production and shared labs remain running. The inherited `M59_WATCHDOG_PINNED_MS=2147483647` is held constant in every arm; it restricts historical healthy-wedge cancellation and is not a new default.
- Client-observed death replay bundles pass integrity checks but remain unvalidated counterfactual reconstructions. Hidden state is absent; no historic death is declared saved without reproducing its baseline. This roster is not a 20-HP / 1-agility reference benchmark.
- Offline validation: **30 movement suites, zero new regressions**, both in the development checkout and after merging with current main. The existing 19 named known-red assertions remain. Resumed-travel checks passed (149 assertions), doorway-side checks passed (27), and pilgrimage dispatcher checks passed (33). The additional legacy wedge suite crashes on its obsolete combat fixture on both original and candidate code; it is not presented as passing.

## Reproduce

Use an explicitly isolated loopback fleet and matching lab environment. These tools relocate characters and must not be pointed at production.

```powershell
node tools/m59-pilgrimage.mjs --fleet YOUR_LAB --port YOUR_BROKER --cycle --timeout 900 --seed 22 --out substrate/tour-sim/forward-new.json --observations substrate/tour-sim/forward-new.jsonl
node tools/m59-pilgrimage.mjs --fleet YOUR_LAB --port YOUR_BROKER --cycle --reverse --timeout 900 --seed 22 --out substrate/tour-sim/reverse-new.json --observations substrate/tour-sim/reverse-new.jsonl
node tools/m59-pilgrimage-report.mjs substrate/tour-sim/forward-new.json substrate/tour-sim/reverse-new.json --out substrate/tour-sim/comparison-new.json
npm run test:movement
```

Restore the same native checkpoint and roster with a fresh lab scope before each arm. These commands alone do not reset world state or learning. `--observations` records cached fleet rows; this investigation's private controller also samples detailed keeper states and saves scenes.

Private evidence: `substrate/replay-smoke/world-tour-2026-10-06` in the deployed workspace. Raw records and rosters remain uncommitted. No production restart or deployment is part of this investigation.
