# Farmer reagent stock and selling trips — 2026-09-15

The production change covers the 21 ordinary farmers. The two separately managed
helpers keep their existing orders. Production loadouts and director state remain
gitignored; backups and the before-release inventory snapshot are under
`substrate/economy-tuning/2026-09-16/` in the deployment checkout.

## Policy

| Setting | Before | After |
| --- | --- | --- |
| Herbs and elderberries, each | Refill below 112 to 224 | Refill below 12 to 40 |
| Capacity that triggers selling | 95% | 80%, by the fuller of weight and bulk |
| Supply-limited farming override | Enabled | Disabled |
| Economy execution | Director lease; its sell circuit disabled | Keeper shopping circuit |
| Farmer station and survival policy | Existing | Unchanged |

Forty of each reagent allows 20 Create Food casts at two of each per cast. Existing
meals postpone a supply-only trip. Full packs can leave independently of food.
Completed sale circuits have a ten-minute capacity-trigger cooldown so unsold or
protected cargo cannot cause immediate repeat trips; supply needs remain eligible.
The caster-specific sapphire, mushroom and orc-tooth loadouts are preserved.

Reducing 224/224 to 40/40 releases **1,288 bulk units and 920 weight units** at full
stock: herbs use 4 bulk/2 weight each and elderberries use 3 bulk/3 weight each.
That is storage for additional loot, rather than a measured income gain.

## Problems found and corrected

The director leased economy even though its selling circuit was disabled. The
keeper consequently skipped its own bank/sell/supply decisions. In the first live
sample, 15 farmers were at least 95% loaded and one was over capacity. Large reagent
stacks, spare weapons and flasks were taking up their packs.

The keeper's full-pack market was exclusively Roq, whose room is banned in
production. Full-pack trips now visit the established equipment, gem and reagent
specialists in Barloque (113, 109, 104). A persistent cursor resumes the current
counter after survival interrupts travel. Herbutte receives stacks of at most 25.
The first production visit exposed a second ownership problem: the director issued
return-to-station while a keeper was at the first merchant. The entire pending
shopping trip now publishes an errand commitment, including the counter phases,
so routine station placement waits until the trip completes or is deferred.

Whole-name keep rules and flattened loadout floors prevented surplus reagent sales.
Both keeper-backed `sell_all` and autonomous shopping now use the same quantity
plan. A finite loadout ceiling reserves the departure stock; only the excess is
offered. Explicit protection, worn equipment, required spare equipment and operator
vetoes remain protected. Known plural aliases such as herbs use the same identity.

For example, 224 elderberries with a 40 ceiling offer 184, not the whole stack.
Independent stack objects share the reserve. One-unit partial offers use the counted
object protocol tag. Sales verify inventory removal, and receipts record quantities.

Gem and empty-flask blanket exemptions are removed from town selling; personal
loadouts and explicit collection orders still protect what is needed. The existing
guild coop retains its policy and receives only surplus, with overflow left for
merchants. Town trips retain the existing funding, restocking and station-return
mechanisms.

## Verification and interpretation

Offline regression checks cover quantity reserves, duplicate stacks, one-unit
offers, explicit protection, interrupted multi-counter selling, merchant equipment,
late operator vetoes, loadouts, town destinations, town stops, purchase funding and
guild coop transfers. Tests use scratch data and do not trade on production.

This is an initial 40-unit/80% policy, not a claim that it maximizes income per hour.
Evaluate realized merchant proceeds minus purchases, time away from farming, loot
left behind for lack of capacity, and travel losses over comparable operating
periods. Reducing stock and making sale trips possible are verified changes; a
sustained net income improvement requires a longer production observation.
