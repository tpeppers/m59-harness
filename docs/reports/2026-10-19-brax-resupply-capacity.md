# Brax resupply and farming capacity — 2026-10-19

The completed real hour produced **86 credited kills: 42 daemon skeletons and 44 narthyl worms**,
with **two deaths in two farmers**, both in Ancient Graveyard of Brax (map 827), and
**no courier deaths**. Logistics delivered actual supplies, but both workers eventually
stopped on separate errors. This is useful progress, not reliable unattended farming.

## Measured result

Each of 21 positively acknowledged farmer orders received its own 60-minute window.
The clock ran 19:04:58.817–20:04:59.621 Pacific on October 19 (02:04:58.817–03:04:59.621 UTC October 20).
The controller finished its durable audit after the last window ended. All 31 archived
critical source hashes matched at the end: the measured build was not changed mid-hour.

| Measure | Completed hour |
|---|---:|
| Intended farmers / ordered survivors / extra couriers |24 / 21 / 2|
| Credited kills in 827 |86 (42 daemon, 44 worm)|
| Farmers receiving kill credit |19 of 21|
| Farmer death incidents / distinct victims in 827 |2 / 2|
| Farmer deaths elsewhere / unknown location or cause |0 /0|
| Courier deaths |0|
| Preparation deaths, excluded from the clock |3 farmers in 827|
| Cleanup deaths |0|
| Confirmed recipient delivery events / distinct recipients |45 /16|
| Delivered goods |163 herbs, 43 elderberries, 8 bread|
| Completed service cycles |3, all by courier B|
| Alive time in 827, ordered 21 denominator |91.71%|
| Alive time in 827, intended 24 denominator |80.24%|
| Hammer equipped during sampled alive 827 time |99.80%|

Deliveries require both giver loss and receiver gain. A lower-to-upper ledge trade,
a return leg, a floor cache, or a pickup notice is not counted as a farmer delivery.
Additional failed service attempts returned safely but are not counted as completed
successful cycles. All 21 survivors actually wore hammers at the start; short equipment
gaps remained in the sampled hour. Kill counters and the credited-kill ledger agreed
for every actor. The ledger lacks unique monster IDs, so these are **kill credits**,
not a proved count of distinct monster bodies.

## Farmer time

Percentages use 1260 ordered farmer-minutes. Missing observations carry no more than
30 seconds and then become unknown. Couriers and the three preparation casualties
are reported separately rather than improving the ordered cohort denominator.

| Sampled state | Ordered farmer time |
|---|---:|
| Healthy waiting |13.62%|
| Other waiting |6.55%|
| Recovery |45.78%|
| Combat or fight attempt |19.28%|
| Movement or pull |6.09%|
| Internal hauling |1.63%|
| Exchange |0.12%|
| Death recovery |0.08%|
| Outside the permitted farm maps |6.22%|
| Unknown/disconnected |0.62%|

Healthy plus other waiting was **20.17%**. That is 254.13 farmer-minutes,
or an average 12.10 minutes per ordered farmer. Recovery occupied another
576.81 farmer-minutes, averaging 27.47 minutes per ordered farmer.
Healthy waiting means known HP and MP at or above observed ceilings and vigor at
least 70/200; it does not mean every source-policy combat condition was satisfied.
The stricter nearby-target/resource candidate amounted to 151.43 farmer-minutes
(12.02% of ordered time). Even that does not prove legal line
of sight, an open approach or a safe pull. Recovery, occupied approaches and these
potential idle periods remain the principal throughput work. Presence in 827 alone
cannot be used as evidence that a character was farming productively.

## Deliveries and return failures

Courier A's first measured service stopped during upstairs distribution when a recipient
was absent from the giver's freshly read contents, despite cached room 827 on both ends.
This refusal happened before any new offer. Treating it like an ambiguous accepted
transfer unnecessarily ended that worker. Its remaining goods were not claimed delivered.

Courier B completed three cycles. A later BACK failed in the public script's new leading
rest: it selected r1c15 in 578 and did not establish a working resting wall there. The
bounded cleanup returned the courier normally to Jasper at 19:38:43.562 Pacific; it
survived a recovery episode that reached 3/82 HP. Both couriers were then home and
both workers had ended. Deliveries therefore stopped before the farming hour ended.
The supply chain did **not** keep everyone continuously serviced for the full hour.

Preparation had independently exposed and corrected delivery-stock resale, retained
personal medicine being mistaken for export cargo, overfilled packs, missing actual
hammers, stale item handles and a 90%-trade/60%-idle-rest deadband. These failures and
ordinary corrective journeys were preserved; no admin repair was used after the final
construction cutoff. Forty-five reconciled deliveries are evidence of real logistics,
not evidence that every outstanding food/reagent demand was met.

## Death evidence

The 20 HP farmer died at 19:05:33.329 Pacific while leaving its wall under daemon-skeleton
attack. Its last recorded health was 13/20 then 6/20; the final living frame was in
`passFleeAndRest`. Recovery was attempted but did not get it to cover before the fatal hit.

The 84 HP farmer died at 19:44:37.772 Pacific at r13c36. Its pull return had failed with
`object_blocked`; subsequent refuge attempts repeatedly blocked while health fell
51→26→17→4→0. The full survival trace proves the new farm-danger monitor **did fire**;
zero watchdog interrupts refers to a different counter. A succession of blocked refuge
and refused off-wall logoff fallbacks consumed the remaining escape interval. The exact
interaction between these replacements still needs an executable reproduction before
attributing the death to one guard. The last session began over two minutes before death,
so this was not simply a login-and-instantly-die event.

Both deaths have matching personal death messages and named daemon-skeleton broadcasts,
known 827 locations, linked session evidence and movement/recovery histories. There are
no unknown killers or locations in this hour. This stronger evidence identifies failed
escape mechanisms; it does not establish that every death can already be prevented.
The three separate preparation deaths were also named daemon-skeleton kills in 827.
No replacement or rescue clones were introduced after those losses.

## Comparison with the prior completed lockdown hour

| Measure | Prior hour | This hour |
|---|---:|---:|
| Ordered farmers |20 |21|
| Kill credits |91 (51 daemon, 40 worm)|86 (42 daemon, 44 worm)|
| Farmer deaths in 827 |3 |2|
| Courier deaths elsewhere |1 |0|
| Completed successful service cycles / confirmed farmer deliveries |0 /0|3 /45|
| Ordered alive 827 exposure |89.57%|91.71%|
| Healthy waiting |14.46%|13.62%|
| Other waiting |4.97%|6.55%|
| Recovery |44.98%|45.78%|
| Combat/fight attempt |21.23%|19.28%|

Throughput did not improve in aggregate:86 is five fewer credits than 91. Observed deaths
were lower and logistics moved supplies, but this is **not a clean A/B comparison**.
Population, survival through preparation, source/build, initial inventory, native fixture
fidelity and time classification differ. The 85%exposure target was exceeded for the
ordered survivors and missed for the intended 24 farmer workforce (80.24%). The earlier
16-kill trial remains more strongly confounded by its source-policy reproduction error.

## Changes made after this measurement

These changes were **not** part of the frozen hour and cannot explain its statistics:

* A missing recipient now has a typed `recipient_not_visible` receipt with explicit
  `submission.attempted:false`. The service defers that recipient and continues other
  deliveries. An ambiguous accepted trade still requires reconciliation.
* The optional public `brax-cache-delivery` fallback puts only surplus delivery provisions
  on the accessible 827 floor after direct distribution. Native packet checks retain the
  full source floors, worn/protected kit and caller-owned body. Giver loss and new ground
  quantity must both be confirmed before availability is published. Durable intents prevent
  replay after an uncertain drop; that item is quarantined without forcing the courier to
  wait for pickup. Available floor quantities also reduce replacement purchases;
  partial pickups and merged stacks cannot be counted twice. Floor caches and
  later pickups have separate accounting.
* Structured broker `delivery_notice` records identify item, quantity, ground handle and
  map/row/column. They are persisted, pushed to the recipient keeper when available,
  exposed in native state, and can be listed or ignored. A group notification shares
  one ground proof and bounded parallel metadata delivery. Notices never invoke game speech
  or force a movement order. Pickup may be deferred or ignored, as requested.
* BACK no longer makes a generic rest detour before the already guarded return rail.
  OUT retains its departure floor; explicit exchange health goals still use ordinary
  verified safe-wall recovery. Protected recovery remains with the keeper.

These post-hour behaviors have executable offline/native-boundary regression coverage;
they have not received a second real-hour measurement. The report will be updated if a
separate native qualification is performed; it must not be described as another completed
hour. The earlier passage/body-authority and future shadow-construction corrections are
included with these owned harness improvements.

## Reproduction limits and operating state

All 26 source policies, complete normalized external loadout files and native carry floors
matched the captured manifests. Source hammers and other starting gear were approximated
from the production snapshot; hidden charges, condition, rarity and server-only state are
not guaranteed equal. The initial saved-login pose issue was corrected before the final
admin cutoff (16:43:33.023 Pacific); subsequent activity was ordinary play only.

A future construction fix replaces direct held-stack quantity writes with the item's
owner-notifying AddNumber/SubtractNumber path. The current cohort was not admin-repaired
after cutoff, so a possible stale cached holder-capacity fixture remains a confound; it
is not proved to explain a specific refusal without the original quantity trace. Three
preparation casualties selected the 21 survivor cohort and further limit comparisons.

After the audit, only this trial's broker and 26 keepers were stopped. Independent process
and port checks confirmed native `blakserv` PID 41300 still listening on 15959 for replay work.
The credential worktree and evidence remain. Production broker 8901 and the deployed
checkout were not operated or changed.

## Publication validation

The final merged build passed all 158 offline movement suites with zero new
regressions; existing assertion baselines were retained. The complete Brax
logistics package passed, including actual pre-offer supply receipts, controlled
drop confirmation, optional broker notices and continued distribution. Shadow
fidelity passed 124 checks and run isolation passed 10 checks. These regressions
validate the post-hour repairs; they are not another farming-hour measurement.
The publication includes main through `2777b86d` and preserves its independent
combat support, arrival and optional Rescue routing changes. Production deployment remains a separate operation.
