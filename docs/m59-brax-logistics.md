# Brax farmers and mainland couriers

Keep farmers stationed in Ancient Graveyard of Brax (827). Their ordinary service
corridor is 827 -> 826 -> the upper eastern returnable component of Cragged (578).
Two separate mainland couriers use Jasper -> Lake of Jala's Song (568) -> lower578.
`tools/fleetscripts/brax-ledge-leg.mjs` exposes each role's `out` and `back` leg.
It has no elevator operation or transport spell. Native small-cargo trades and both
returns passed on the local server on2026-10-19. Procurement/service qualification
and the new measured farming hour are recorded separately in the capacity report.

## Movement boundary

`movement_region` is a policy object with `version:1`, an operator-chosen `id`,
positive integer `rooms`, and optional `anchors` indexed by permitted room number.
Each anchor has named **protocol fine** `x` and `y` (64 units per square). For example:

```json
{"version":1,"id":"brax-farmer","rooms":[578,826,827],"anchors":{"578":{"x":2352,"y":2208}}}
```

The packet mutation hook checks the current room and body before movement or GO.
An anchored room admits only segments inside its native-collision **bidirectionally
returnable** component. Endpoint membership alone is insufficient: the swept segment
is sampled and traced in both directions. Unknown geometry/position, unsupported
activation, unknown/transport spells and transport items refuse with native status
under `coordination.movement_region.last_refusal`. Normal healing and food remain
available. The lower courier anchor is `x2256,y2208`; the horizontal gap is96protocol
units with896client-height units between floors. These inset positions are deliberate.
Do not substitute square centers or walk either body toward its trading peer.

The lock persists as policy across ordinary reconnect/handoff. Underworld escape
is exempt; subsequent displacement outside the contract quarantines movement and
requires a separate operator assignment. Death never starts another elevator trip.
Confinement and region contracts complement each other: autonomous errand selection
should also be disabled so refused trips do not consume the farmer's work loop.

## Source policy and task overlay

Use `clonePolicy` and `policyFidelity` in `m59-shadow-policy.mjs` to copy the entire
source policy, recursively remap selected actor identities, list scenario differences,
and compare every expected key against the actual keeper policy. False, zero, null
and nested fields must survive. Do not reproduce from broker defaults.

Policy is only one input: source `substrate/loadouts/<character>.json` files also
control gear, carrying minimums, selling and procurement. `cloneLoadout` remaps
identities and records explicit scenario differences, including absent source files.
Copy source sections before applying the task overlay; audit keeper
`loadout_retention` as well as the full policy. Suppress replay of source loadout
policy only when the native policy manifest already contains it plus task changes.

Use positive **carry minimums** for operational stock (hammer, edible food, healing
herbs and cooking elderberry). Do not add consumable food to `protectedItems` for
this purpose: that list excludes it from the larder. A carry floor holds stock back
from eviction but still lets food be eaten and spells consume reagents. Native loot
eviction also excludes equipped objects by ID and rechecks before the paced drop;
a same-name spare must not cause the worn object to be selected instead.

The farming overlay stations827, targets narthyl worms first for Qor casters and
daemon skeletons first for others, equips hammers with hammer-only training, disables
personal town/buy/delivery/strategy/buddy errands, and retains source survival/healing
preferences. Mainland courier policy has a separate lower578 anchor and Jasper road
allowlist. Extra couriers are excluded from the24-farmer denominator; the upper
runner is one of those farmers and its hauling time must be counted.

## Stationary exchange and supply service

`BraxSupplyService` takes identity-fenced ordinary `call`, native `read`, public
`runLeg`, event/phase callbacks, actor roles and exactly two couriers. It serializes
lower approach plus upper handoff, while the other courier may procure or return.
A merchant gate prevents simultaneous use of the same NPC. An exchange failure does
not free an occupied lower stand: the next admission needs native clearance proof. A retained native journey
is observed through recovery; it is never restarted because an HTTP travel reply
arrived before the body completed its owned recovery. A changed life or owner refuses.

Procurement uses `buyCourierGoods`: persist intent before one purchase, then prove
cash decrease and item increase. Nonstackable stock may require separate, reconciled
purchases. Unknown purchase results stop that worker. Transient autosave handle invalidation
repeats bounded inventory reads only, never an accepted purchase or trade. Every cargo transfer checks
both receiver capacities, protects worn/reserved stock, journals intent/result and
requires inventory deltas. Pre-window offer failures retain native submission and both
message streams, and reconcile both inventories before classifying capacity. A partial stack is explicitly partial. Unweighable cargo
and unknown receiver load defer. Native capacity refusals override table predictions;
only a proved zero-transfer full-pack refusal is deferred, and it cannot produce
another offer until the receiver pack changes. Pre-offer readiness refusals wait
without claiming delivery. Stopping the service prevents unstarted queued trips while
finite accepted legs finish; do not keep ordinary farmers working past the measurement
deadline while waiting for that cleanup. Medicine is packed before heavy bread. Purple/blue/red mushrooms are reagents, not
food. Hammers and other cargo keep a sixteen-unit capacity margin. A native receiver-full refusal at the computed75-bulk boundary disproved the previous zero-margin hammer exception; known item classes do not establish the server holder counter.

Use `supply` with `stationary:true` and `who_travels:'neither'`. This requires the
GOAP keeper driver and finite directional tokens (20s default,30s maximum). Survival
runs before the stationary hold. Rung identity follows awaited and paced callbacks, including sharing/idle-gear work
before the ladder. An older ordinary offer/counter/accept/cancel or movement cannot
destroy the handshake. Protected survival retains priority. Damage, displacement, new life, expiry, casting,
food use, combat or movement preempts it; queued trade callbacks recheck the token.
A body below90%HP is not admitted. Record this as a service limitation if injured
farmers cannot receive provisions. Do not substitute an inert survival-off hold.

Delivery to the runner is not delivery to the workforce: verify each recipient.
Defer full packs, preserve unknown transfers, and retain unsold loot. Jasper's reagent
merchant Zhieu B'hob buys reagent/gem items; measure actual purse change, including
its poor prices. Yevitan is a banker and must never be treated as a loot buyer.

## Crowded farm entrances

`stageCrowd` in `m59-crowd-staging.mjs` takes native `readAll`, an owned single-body
`runStep`, room geometry, a spacing target and finite step/time budgets. It chooses
only healthy available declared bodies; foreign leases, active casts and movement
remain untouched. Every step has native collision and reverse-terrain proof. A
failed or ambiguous step ends the run. A budget ending or no further proved step is
reported explicitly; neither establishes that every actor has reached the spacing target.

`chooseCrowdClearanceStep` accepts a larger spacing target without changing native
collision rules. `roomStagingGuard` bounds the entire segment and excludes room
portals. Collision-valid BSP leaf space beyond the grid is not a staging destination:
one captured test walked a farmer normally into826 that way. The corrected guard
rejects that segment and allows an observed edge arrival to leave toward the interior.
The ordinary return is retained in the trial evidence, with no teleport or reset.

A returning upper runner clears its own crowded827 landing before releasing its
work lease. When that cannot be proved, the leg reports the obstruction. A later
service failure resumes the requested farm mode only if native evidence confirms
that the runner is alive, home, idle, without pending movement and owned by its
keeper. Pending/unknown legs receive no replacement control. Ended service stalls
have their own time categories, so a stale phase is not counted as physical hauling.

## Measurement

`farmObservationDetails` retains recent explicit decisions, fight outcomes, native
connection/position evidence and nearby target candidates. `farmTimeCategory`
separates recovery, movement, fight attempts, healthy waits, other waits, service,
outside-lock and unknown time. Evaluating a recovery rung alone is not recovery.
`integrateFarmTimes` caps evidence at30s per gap; missing time stays unknown.
Neither a full-resource wait nor visible nearby monsters proves a legal attack path.

Record an actual hour from positively acknowledged farm orders. Keep source/build
hashes, actual equipped hammers, durable kill events and cross-session postmortems.
Separate setup casualties, farming827 deaths, other/unknown locations and couriers.
Compare to the prior16-kill hour with its policy reproduction error as a confounded
baseline. The plan's85% farmer time in827 is an acceptance target, not a guarantee.

Offline checks: `npm run test:brax-logistics`; movement boundary and reversible rail
tests also run in `npm run test:movement`. Runtime rosters, account passwords, actor
logs, source snapshots and private controllers must not be committed.

## Capacity constraints from server source

`necarea2.kod` declares a60/40 daemon-skeleton/narthyl-worm mix,7–9initial
monsters,25monster cap and40,000ms generation period with80% admission chance.
`MonsterRoom.GetMonsterGenTime` divides by five when player scaling is disabled
(the default), including for a24-player fleet. At a100% server spawn-rate setting,
this is an attempted generation every8s, about360successful chance rolls per hour
before cap, blocked-generator placement or empty-room reload effects. This is a
source-derived reference, **not a verified runtime spawn rate or achieved kill rate**;
the local server's saved settings and compiled source identity must also agree.
Adding farmers beyond five does not itself speed this default generator.

Daemon skeletons are level130, aggressive, fast, and take extra bludgeoning damage;
narthyl worms are level120, aggressive and slow. Both resist piercing/thrusting and
unholy/shock/fire attacks in the inspected server source. This supports the requested
hammer setup; it does not establish that20HP support characters can survive contact.
Current native enemy observations, kill credits and damage postmortems decide whether
the workforce is effectively engaging rather than merely occupying827.

## Recipient deliveries and ended journeys

The exchange across the Cragged ledge remains stationary. Inside map827 the
runner uses ordinary `supply` movement: the giver travels for a delivery, the
receiver travels for collection. This moves the runner while the farmer keeps
its post; being somewhere in the same room is not trading range. Reconciled
recipient gains emit `farmer-delivery-confirmed`, separately from ledge cargo
and completed return cycles.

Road returns observe the exact accepted native journey through protected
recovery. They never submit a second journey because the first RPC ended early.
An ended service may return remaining cargo home only after native live body,
released control and absence of a job or movement are proved. Ambiguous accepted
trades remain failures; pre-submission stale cargo may defer without an offer.

Courier procurement buys the actor's own food and usable kit before bulk cargo,
then prioritizes a missing farmer hammer before optional medicine. Once everyone is armed, usable medicine precedes spare weapons. A sixteen-unit native weight
and bulk margin avoids the near-full-pack purchases that the server could not
reconcile. Reserves use actual spell knowledge and external carry floors: a cook
without healing retains six herbs, a healer twenty, and a noncaster no unused
medicine unless the source loadout explicitly retains it.

Purchase journals survive controller changes. A submitted or unreconciled intent
blocks another purchase of that agent/seller/item before even quoting again.
Confirmed independent cargo can still be delivered and other goods procured;
the unresolved intent stays visible rather than terminating all supply work or
being silently repeated. Preserve the same journal directory across preparation
and measurement. Receipts retain the complete shop reply as well as inventory
and cash deltas.

Idle telemetry requires known health and mana ceilings; values at or above those
ceilings count as resource-full. An observed over-ceiling mana value is not a
reason to classify a waiting character as depleted, and absent mana is not proof
of full resources. Comparisons with earlier reports must disclose this classifier
change or reclassify the earlier raw samples with the same rule.

The runner distributes existing provisions before collecting more loot. At the
ledge, medicine precedes spare weapons; a bounded fresh loading pass follows
verified exports so newly freed capacity is used before either side returns.
Only independently confirmed remaining cargo is selected again. Partial or
ambiguous accepted transfers still end the exchange, rather than being replayed.

Pool purchases reserve 256 units of both weight and bulk for exported loot;
the courier's own travel kit may use that reserve down to the conservative
sixteen-unit margin. Filling every remaining slot with delivery cargo leaves
neither side able to accept the other side's load, even when both arrive alive.

Courier merchant calls exclude provision names through the native keeper's
`skip_names` filter. A copied source loadout ceiling can deliberately outrank
`keep`, and qualification actually sold seven delivery hammers despite that keep
list. Filtering those names before offers preserves the delivery cargo while
retaining the full source loadout rules for everything else; it does not disable
loadout protection or turn the courier's cargo into a permanent personal floor.

Cargo planning accepts both the native inventory tool's numeric `ids_as_of` plus
`last_save_at` and the detailed observer stamp. A save newer than the planned
inventory time defers before submission even if a recycled handle has the same
item name. This is a new read/plan decision, not a replay of an accepted gift.

While any farmer still needs provisions, collection before the ledge trip takes
cash but defers additional heavy loot. Filling the upper pack again before an
incoming delivery defeats reserved lower capacity. Recipient-room exports still
move the surplus needed to accept a delivery, and existing runner loot is sold
through the courier as usual. Unarmed farmer demand precedes optional supplies;
upper stock is capped at current demand, personal reserves and one spare hammer.

The courier stays in town during upper local preparation, then both physical
approaches overlap under the same exclusive lane gate. Both accepted approaches settle before failure cleanup; one rejection
cannot abandon the other live actor. A native47/82-HP courier was refused by the
stationary exchange guard, so arrivals now wait for normal recovery, released
work/movement, no combat/cast, the correct stand and readiness cooldown. A body
that recovery moved away may make at most two new ordinary approaches after the
previous leg is proved ended. Death/new body, timeout or stop ends admission;
no admin help, blind repeated movement or replay of an ambiguous trade is used.


A stationary trade health floor is higher than some source policies' idle-rest
trigger. In the native qualification a courier remained at75/88HP: below the
90% exchange floor but above its60% rest trigger. Waiting for an idle recovery
that has no reason to start cannot close that gap. `BraxSupplyService` accepts
an explicit `recover(agent,{health})` dependency and requests a full-health goal
only after the previous body work is known ended and no protected recovery,
combat, cast or movement is active. Use the public `brax-service-rest` script:
it uses FleetScript's verified safe-wall rest and verifies the native result.
Never implement this callback as a heal grant or unguarded rest in the open.
The request and native readiness observations are recorded, with at most two
health goals and two reapproaches per actor in a bounded admission attempt.

`brax-ledge-leg` now enforces its advertised `minHealth` with that same ordinary
rest primitive before departing. It previously passed an unused parameter to
the route helper. Healthy departures skip rest without moving to another wall;
a hurt actor must reach verified cover and regenerate normally. The full source
policy and external loadout remain intact. Qualification, incomplete trips,
zero-transfer refusals and setup deaths are evidence, not deliveries or part of
a later successful hour. Farmer deliveries require confirmed receiver gain,
not just a lower-to-upper exchange or a physically completed return cycle.


## Deferred recipients and optional floor caches

`recipient_not_visible` with `submission.attempted:false` is a typed pre-offer
refusal. Defer that recipient and continue the other direct deliveries. It is
not permission to retry a partial or unknown accepted trade. Cached room equality
also does not establish that a recovering/logged-off recipient is visible now.

For the explicitly authorized Brax floor fallback, instantiate the service with
`cacheDelivery: publicBraxDeliveryCache` imported from `m59-delivery-cache.mjs`.
The public `brax-cache-delivery` child owns the upper runner for a bounded drop-off
after direct local distribution. It caches only confirmed provision surplus
needed by other farmers, above the runner's personal reserves and full native
loadout floors. Worn, protected or unknown equipment never qualifies. The cache
is in 827, where farmers can retrieve it; putting goods below the 578 ledge would
make them unavailable to the locked farmers.

Every drop has a durable intent before one native packet. A missing confirmation
quarantines the item for reconciliation and prevents another drop, while allowing
courier movement to continue. A confirmed cache requires a giver quantity loss
and a matching new ground quantity at the observed square. It is a cache, not a
confirmed recipient delivery. `delivery_notice` publish/list/ignore provides
structured optional pickup facts through the broker, persists them, and pushes
them to an addressed keeper without game speech or movement. Native state exposes
`delivery_notices`. Offline notification delivery may remain pending; the broker
list remains available. Nobody waits for a pickup acknowledgement.

The completed trial exposed an additional return hazard: a generic leading rest
selected r1c15 before BACK and could not prove arrival at a working wall. BACK now
uses the checked return leg's own recovery handling, with no extra generic rest
route. OUT still enforces its departure floor, and exchange admission retains its
explicit guarded health goal. See the measured result and post-hour distinction
in [the resupply capacity report](reports/2026-10-19-brax-resupply-capacity.md).

Confirmed floor stock reduces new procurement demand until picked up or its notice
expires. It does not count as a completed farmer delivery. Repeated demand reads
do not subtract it twice, and a fresh farm view removes a missing or consumed
cache so actual shortages can be supplied again.

A `publish_many` notice batch shares one freshly verified cache scene across its
recipients. It does not repeatedly request room contents for every farmer.
Keeper notification is metadata-only and bounded to two seconds per parallel
recipient; durable broker notices remain available when a keeper cannot answer.
