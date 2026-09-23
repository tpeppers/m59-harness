# Travel continuation and traffic Blink audit

The third seed-22 reverse shadow tour completed 84 legs and 5 circuits, versus 160 and 14 previously. Its interval was 2026-09-22 22:21:13.077–23:21:17.902 UTC. This audit changes the isolated survival-escalation checkout only. Production remains on hold; no fourth tour was started.

## What reduced travel

The final snapshot has 14 characters in Cibilo Creek Inn (153). Ten still have an active Brownestone Inn journey. The runtime transits contain 32 failed Cibilo exit batches during the measured window. Bbbb alone has consecutive 407,204 ms and 406,341 ms walking batches, each with four object-blocked attempts at the exit to Cor Noth, retaining the same journey ID and destination 106. These are active traffic retries, not lost destinations.

Left-held polling gives 7.5166 observed Cibilo character-hours, with no observation interval over 60 seconds. This is occupancy, including safe rest and inactive characters, not a measurement of time blocked. It helps explain why lower Flatlands exposure accompanied lower throughput.

There is also a real continuation defect. Keeper recovery/vendor travel installed a new travelling posture that unconditionally cleared the suspended tour. Aaaa, Cccc, Dddd, Oooo and Rrrr show an interrupted tour followed by a different sanctuary destination and an eventual idle snapshot with no pending tour. The patch reproduces the parent-loss mechanism offline. The old capture lacks complete journey-state mutation history, so it cannot uniquely attribute every idle character to that mechanism. Iiii, Pppp and Uuuu also ended without a retained destination; Ssss and Tttt retained theirs.

Equipment remains a separate limitation. Pppp and other unequipped characters repeatedly waited for mana despite already having enough to attempt conjuring; existing equipment-policy refusals prevented arming. This patch does not permit forbidden weapons or force an unarmed character back into danger. Retaining a destination does not guarantee that its safety prerequisites can be satisfied.

The companion evidence is substrate/survival-retreat-tour-20260922/travel-blink-audit.json: exact bounds, per-character final state and recent journey receipts, observed Cibilo occupancy, all failed Cibilo batches and initial Blink resources.

## Continuation changes

Recovery detours explicitly suspend their parent, cancel the old movement owner, and retain that parent through the detour's normal travel safety posture. Ordinary keeper travel, including vendor trips, also preserves an already-suspended parent. External orders still enter through travelJob/goTravelling and retire the old objective. Repeated shelter/watchdog takeovers preserve the parent instead of replacing it with the detour's destination.

No local copy restores a destination after an await: stop, cancellation, new orders and death can still remove it. Existing stale/attempt/death resume limits remain. Structured travel_recovery_detour and travel_parent_retained events expose the two destinations. A live travelJob now renews only its own lease, avoiding the observed 900-second expiry/reassert cycle while a driver was still working.

## Blink accessibility and evidence

The shadow checkout had no substrate/strategies directory and the measured tactics contain zero blink_escape rows. All 21 characters knew Blink; seven began below the new fallback's 18-mana reserve. Ability readings were 5 for twenty characters and 3 for Nnnn. A separate keeper blinkFree count is not evidence of the traffic rung running.

A shipped traffic fallback now exists even without private strategy files. It is reachable from the walker and from a measured pending-survival jam after doing=null. It uses the existing reachability predicate with live blocking bodies and the fixed room teleport location, refuses an occupied landing, and requires known Blink, at least 90% health (or a stricter supplied floor), 18 mana, 40 vigor, ten seconds of measured blockage and no recent incoming damage. Attempts have a 30-second cooldown. Pending survival asks at most every five seconds and uses an already-cached onward exit; an unavailable exit is an explicit refusal, not an expensive route search on the survival clock.

An explicit private blink-escape policy still overrides the fallback, including disabled/declining/broken policies. M59_TRAFFIC_BLINK=0 disables traffic casting. The original health-aware combat/retreat and safe-cover gates remain; no player aggression was added.

The blink_rung ledger and status counters distinguish decision refusals, selections, pre-cast refusals, actual casts and verified landings. Identical decision-refusal receipts are throttled for 30 seconds while every ask remains counted. Position, landing, goal and blocking-body snapshots accompany decisions. Casting rechecks geometry/resources and is bound to the original client, life, room and movement generation. Cancellation releases the cast's own pacing pause before a replacement owner takes over. Death/respawn or an unrelated move cannot count as a successful landing.

Verified landing is deliberately not called a completed bypass, exit or journey. Those outcomes must be joined to subsequent movement and journey receipts. The hypothesis that Blink should solve 40–50% is unmeasured: the fixed landing can be on the same side of a jam, occupied, disconnected from the intended exit, or unaffordable. The run's missing strategy makes it unsuitable for estimating that fraction.

## Verification

Offline traffic/continuation and survival integration tests pass, including real travelling posture, real pending dispatcher, parent resumption, nested takeover, new-owner cancellation and death before/during a cast. The existing resume suite passes 149 assertions, continuity 22, strategy loader 19 and lane suite 54. The movement gate retains its named baseline of twelve needle and four travelling assertions; no production or live shadow behavior is claimed from these tests.

Two older source-spelling assertions were updated to recognize null-coalescing preservation of a suspended parent; executable regressions cover the behavior itself. Runtime logs and evidence remain uncommitted.
