# Arrival estimates and Rescue travel

`/arrivals` shares its route enumeration and whole-journey simulation with
`Session.travel`. FleetScript `walk` uses that travel path; the named
`rapid-arrival` script is a convenient destination-based entry point.

The page defaults to inspecting current eligible resources in the keeper.
What-if modes assume a full individually carried chalice, affordable learned
Rescue, or both. They do not assume the shared station can serve everyone at
once. The guild-hall input is a what-if assertion, never a membership change.
A hometown is read from the exact roster's durable hometown cache.

P90 is conditional on successful completion. Simulated walking legs sample
current-movement-epoch directed crossing durations only when at least five
successes exist; otherwise a visible seconds-per-hop assumption is used.
Failed crossing counts are displayed separately. Native Rescue delay is
15 seconds minus spell-power reduction, with a 50% chance of another 5–10
seconds. Whole journeys are simulated rather than adding individual P90s.
Spell estimates currently use power 1. A one-second action allowance per
teleport and a configurable dispatch allowance are assumptions, not samples.
The group result assumes independent travel and individual resource access.
It measures map arrival, not positioning or a first useful combat action.

Private `rescueTravel(ctx)` policy enables routing per character. Its result
is `{enabled:true,double:true,guildName,guildHall,fallbackMs?,blocked?,confine?}`.
With no enabled policy, travel is unchanged. The policy lives in the private
strategy repository and is installed under `substrate/strategies/`; reload
keeper code/strategies using the normal keeper handoff after changes.

The selector considers walking, a single teleport, and two-stage combinations
of chalice and learned Rescue. It can approach the orc caves or Pool of Vigor
before teleporting. Guild-region precedence is evaluated at each landing.
Blocked rooms and confinement apply to staging, landings and walking tails.
A full carried chalice can fund two uses while preserving its last charge.
The executor retains the cup; it does not borrow the shared service cup or
change hometowns. Insufficient stock leaves the route unavailable.

Before every teleport the executor rechecks guild, hometown, resource budget,
health, ownership and the ten-minute attack lockout. Native confirmation and
the expected new room are required before another sip/cast. Ordinary walking
legs retain the existing journey and survival guards. No new attack order is
created by the tactic. Active combat owns the body and blocks Rescue routing.
Journeys requesting an exact arrival component or a puzzle handoff retain
ordinary routing: a map-level teleport cannot prove those conditions. Queued
item/spell sends also reject IDs invalidated by a server save.

Receipts live in the resolved evidence directory's `rescue-travel/` folder.
The receipt is marked pending before dispatch. A timeout, unexpected landing,
process loss or cancellation preserves uncertainty and prevents automatic
recasting. Reconciliation requires checking the character and recorded native
outcome; do not erase an uncertain receipt simply to retry the route.

Validation: `m59-arrival-test`, `m59-arrivals-page-test`,
`m59-rescue-travel-test`, existing `m59-rescue-test`, and the movement suite.
`m59-rescue-chain-probe.mjs <new-report> <local-replay-config>` is an isolated
native acceptance probe. It uses lab-only fixture powers to establish the
starting guild, home and cup, then ordinary player packets for both landings.
An offline lab is a missing native result, not a passing probe.
