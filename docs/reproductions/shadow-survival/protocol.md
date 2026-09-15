# Shadow comparison protocol — 2026-09-14

Fixed before the matched runs. Calibration pilots are excluded from the main totals.

Question: do the two additional, default-on travelling-pass reconnect decisions reduce
deaths, and do characters reach safety? This is a live policy ablation, not a replacement
shopping scheduler. Both arms use external travel on production code e1c26da. Control
disables only `travelGuard.flee` and `fight_back`, reproducing the absence of these two
decisions during an internally awaited shopping leg. Treatment enables both. Optional
`arm` remains off. Shared movement shelter, hop recovery, watchdog and freeze logic stay
as implemented. Neither arm starts merchant errands automatically.

Eight matched pairs: shadow01–04 on room 584 → Brownestone Inn (106), shadow09–12
on Cragged Mountains (598) → Familiars (52). For each route, actors 1 and 3 receive
control then treatment; actors 2 and 4 receive treatment then control. One active trial
per route, with the two geographically distinct routes running concurrently. This is
counterbalanced order, not random allocation or random sampling from production.

Each run gets a fresh keeper process, 20/50 health, 160 vigor, only a mace equipped,
400 shillings, and four newly created trolls placed adjacent to the start and given the
character as their target. Attacks and subsequent movement use the real server AI; no
damage is injected. Monster health is randomized normally. Character attributes,
skills and remaining inventory are not cloned; actor pairing controls their baseline
differences imperfectly because deaths may drop items. No armor is equipped. These are
deliberately severe, wounded-start encounters, not estimates of normal shopping risk.

Start squares: room 584 row 35 col 27; room 598 row 35 col 25. The DM relocation result
and actual cached state are saved. Guards are the sole intended between-arm policy
difference. Common policy values and full starting snapshots are recorded by the driver.

Primary outcomes within 300 seconds: observed death; arrival at the destination inn;
alive without arrival (censored, not counted as rescue). Record minimum observed HP,
arrival/death time, guard notes, reconnects, held recovery and onward progress. Sampling
reads the keeper's cached state once per second without sending inventory or other
waking packets to the server. A death is room 1, zero HP, or loss of maximum health.
Maximum health is restored between runs, never inside a run. Stop following a trial at
its first death or first arrival. Merchant purchase and subsequent farming are not part
of this primary endpoint and must not be inferred from arrival.

Remove only owned, marked test monsters after each run. Restart keepers between trials
to avoid freeze-history carryover. Preserve all valid outcomes, including failed
interventions; distinguish staging/driver failures from character deaths. Report paired
counts and uncertainty without treating seconds of observations as independent samples.
Any follow-up or guard-isolation trials must be labelled exploratory and kept separate.

Production is read-only. Restore the original shadow runtime and policies when finished.

Exploratory extension specified at 08:00 UTC, after seven severe runs had all ended in
death: four additional matched pairs, shadow01–02 and shadow09–10 on their same routes,
35/50 release health and two trolls, otherwise identical conditions and 300-second
endpoint. First actor control → treatment, second treatment → control. This checks a
less overwhelming encounter where continuing might work. It is an adaptive follow-up,
reported separately from the eight severe pairs; no completed severe outcomes are dropped.

A second exploratory extension, specified before its runs: two Flatlands pairs on
shadow01–02, 50/50 health and two trolls. Treatment enables only `fight_back`; both
arms disable `flee` and `arm`. Counterbalanced order as above. This isolates the rate
decision, which the earlier low-health branch can otherwise preempt. Starting at full
health also avoids introducing a large artificial damage step during staging. This
does not measure the added marginal benefit of `fight_back` when `flee` already fires.

Execution record: all 16 primary runs and the four milder Flatlands runs completed.
The milder Crag and isolated-rate commands were rejected before starting because the
automatic approval review model was at capacity. No outcomes exist for those runs;
their planned designs above must not be mistaken for completed experiments.
