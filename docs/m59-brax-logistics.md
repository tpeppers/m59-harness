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
requires inventory deltas. A partial stack is explicitly partial. Unweighable cargo
and unknown receiver load defer. Medicine is packed before heavy bread. Purple/blue/red mushrooms are reagents, not
food. Critical hammers use exact known capacity; optional cargo keeps a margin.

Use `supply` with `stationary:true` and `who_travels:'neither'`. This requires the
GOAP keeper driver and finite directional tokens (20s default,30s maximum). Survival
runs before the stationary hold. Damage, displacement, new life, expiry, casting,
food use, combat or movement preempts it; queued trade callbacks recheck the token.
A body below90%HP is not admitted. Record this as a service limitation if injured
farmers cannot receive provisions. Do not substitute an inert survival-off hold.

Delivery to the runner is not delivery to the workforce: verify each recipient.
Defer full packs, preserve unknown transfers, and retain unsold loot. Jasper's reagent
merchant Zhieu B'hob buys reagent/gem items; measure actual purse change, including
its poor prices. Yevitan is a banker and must never be treated as a loot buyer.

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
