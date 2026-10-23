# Initialize standing Brax farming

Run **`brax-farm`** from the deployed checkout on the broker machine. This is a
finite initialization, followed by ordinary keeper farming and a managed courier
process. It does not run a one-hour experiment, clone characters or change the server.

First preview explicit roles without connecting to a broker or changing anything:

```powershell
node tools/m59-brax-farm.mjs plan --agents t1,t2,t3 --couriers c1,c2 --runner t3 --archers t2
```

Replace those example IDs with the intended automated actors. `agents` names
**1 through 25 farmers**; `couriers` names **two additional mainland characters**;
`runner` is **one of the farmers**, able to carry supplies and loot through the
caverns. No actor is inferred from a wildcard, wealth, religion or max HP. The
initializer refuses missing or human-piloted roles before taking their run locks.
An already active or unresolved supply-worker reservation also refuses a new run.
`archers=auto` (the default) detects an existing bow weapon preference or explicit
Fire/Archery learning target. Use an explicit subset to override that detection,
or `archers=none` for only hammer farmers. The upper runner cannot be an archer.
Finish any previous training FleetScript normally before acquiring its body here.

For production, after deploying the committed implementation and verifying the fleet:

```powershell
$env:M59_CONTROL_URL='http://127.0.0.1:8901/'
node tools/m59-which.mjs --fleet prod
node tools/m59-fleet-repl.mjs --fleet prod
```

Then in that REPL:

```text
describe brax-farm
dry brax-farm agents=t1,t2,t3 couriers=c1,c2 runner=t3 archers=t2
brax-farm agents=t1,t2,t3 couriers=c1,c2 runner=t3 archers=t2
```

The initializer requires a loopback broker whose reported fleet, absolute roster
and checkout root match its own. Use the actual deployed checkout, not a development
worktree pointed at production. It refuses unobservable roles and existing workers.

## What the initialization does

1. Acquire normal FleetScript control over every explicitly selected actor while
   leaving survival, mortality and recovery with its keeper. Verify native living
   keepers, complete spell lists, source policies and matching local/broker
   loadouts before any policy or game change.
2. Save the complete source policies and raw loadouts. Disable old farming
   assignments, stationary enchantment posts, buddy work, practice and personal town
   errands for this task. Preserve survival/healing settings, gear in other slots,
   learning plans, sale rules, unrelated carrying floors and operator notes.
3. Normally buy missing kit in Jasper: one hammer, six loaves, and herbs/elderberries
   for known healing or food spells. Existing higher stock floors stay higher. No
   cash, item or stat grants occur. Insufficient cash/capacity or an unconfirmed
   purchase fails preparation for the group before the lift route starts. Every
   accepted operation settles; unknown purchases are journaled and never replayed.
4. Equip and verify actual hammers. After the whole group finishes preparation,
   farmers run the existing **`walk-to-brax`** route as one requested cohort. The two
   couriers stay on the mainland and finish in Jasper (350).
5. On living arrival in **Ancient Graveyard of Brax (827)**, install the standing
   task, verify native policy and carry floors, and hand the farmers back to their
   keepers in farm mode. Both daemon skeletons and narthyl worms are acceptable;
   known Qor casters prioritize worms, everyone else skeletons. Weapon training is
   hammer-only for ordinary farmers. Archers retain a bow plus a backup hammer and
   stay idle until the managed ArcherPlus task claims them. Food is a carrying
   minimum, not a protected item that cannot be eaten.
6. After every selected actor succeeds and the outer run releases its locks and
   leases, launch the managed supply worker and selected ArcherPlus tasks once. A partial result is explicitly a
   failed initialization, not "somebody arrived, so the group succeeded". It does
   not start another worker or silently send missing actors through repeated lifts.

Farmers remain confined to **578, 826 and 827**, with the hard upper-component
anchor in 578. Couriers have the Jasper/568/lower578 road allowance and the separate
lower anchor. Confinement also applies to ordinary recovery. The upper farmer runner
uses 827–826–upper578 and back; the couriers never take the Ancient Place lift.

**`farm_room=828` farms the Decaying City of Brax** (operator, 2026-10-23), the
room directly east of the graveyard. The default stays 827. `substrate/m59-spawns.json`
gives 828 narthyl worms (60%) and tusked skeletons (40%) and **no daemon skeletons**
(those generate in 827, 829 and 830), so an 828 farmer hunts tusked skeletons and
worms, Qor casters worms first. `walk-to-brax` still ends in 827 and arrival is still
checked there; the standing `assigned_room=828` is what walks each keeper on. 827 stays
in the farmer confinement and movement region (578, 826, 827, 828), because the runner's
ledge leg is 827–826–upper578: it leaves 828 through 827 and its return crosses on into
828 instead of clearing the graveyard landing. Local deliveries walk only within one
farm room. Floor caches remain 827-only — the keeper's delivery-cache drop refuses any
other room — so an 828 runner delivers directly and drops no caches. ArcherPlus gets
`room=828` and `allowed_rooms=578,826,827,828`. Anything else (829 and beyond) is refused.

The [ledge supply service](m59-brax-logistics.md) handles ordinary purchases, sales,
stationary ledge exchanges, deliveries, bounded relay/floor-cache fallback and both
return paths. A courier handoff is not counted as a final farmer delivery.

Already upstairs? The existing route can recognize an arrived farmer, but the
initializer will not send it down to Jasper for missing kit. Supply that actor
normally before resuming. This also prevents reinitialization from undoing the
one-way migration boundary.

## Status and stop

The worker survives closing the REPL. It has no reboot/restart auto-resume: an
uncertain purchase, trade, journey or worker launch must be reconciled first.

```powershell
node tools/m59-brax-service.mjs status --fleet prod
node tools/m59-brax-service.mjs stop --fleet prod
```

Status includes PID/start metadata, phase, per-actor service phases, completed
cycles, confirmed recipient-delivery event count, ArcherPlus task receipts, and errors. Stop ends new work
and lets accepted transactions/returns settle. Farmers retain their standing
farming assignment; stopping logistics does not order another migration.
An operator taking a body or changing its Brax assignment invalidates the worker's
observations rather than being overwritten.

Runtime files live in ignored `substrate/brax-farm/<roster-hash>/`: `status.json`,
the token-owned `controller.lock`, and a dated run directory containing the source
backup, manifest, preparation/arrival receipts, purchase journals and events.
Never delete a live or unknown lock, repeat an unknown launch, or rerun an accepted
purchase to make its result look complete. A crashed controller leaves its claim
for inspection. The worker does not restart brokers or keepers.

A completed process with `needs-attention` status also blocks reinitialization.
Inspect its receipts and resolve any submitted operations before archiving that
status file. Starting a fresh run directory is never a way to retry an unknown
purchase or trade.

Task changes intentionally persist. To leave Brax farming, stop its supply worker,
inspect the saved source files and issue a separate desired assignment. Restoring
an old policy is not an instruction to walk down from Brax.

## ArcherPlus roles

Install the updated private `strategy/fleetscripts/archerplus.mjs` into the deployed
`substrate/fleetscripts/` using the normal private-file deployment process. It must
declare integration version1 with stationary supply, allowed rooms and cooperative
stop support. The initial upstream `4930bc7` alone lacks those additions. The
private source requires this harness's `tools/m59-bow-supply.mjs`; deploy the public
helper before installing the new private file. Never copy private strategy source
into the public repository, install credentials over a live roster, or replace all
private policy to install this one script.

After all arrivals succeed, the manager runs one real `archerplus` FleetScript per
archer concurrently with the two couriers. It passes the farm room (827 by
default) and allowed rooms 578/826/827 (plus 828 when farming it), and only the selected hammer farmers as assist targets and supply
donors. Brax defaults to `archer_mode=snipe`, spending arrows on near-death targets;
`archer_mode=both` also tags and holds farmed targets while waiting, as the private
script does by default when run independently. The default session is four hours;
`archer_hours=` changes it. Completion/stalls remain visible in the worker's
`tasks` receipts; they are not automatically restarted. `archer_arrows=160` is the
top-up target, and five arrows plus the actual bow are required to leave preparation.

Available imported bows/arrows are shared by ordinary stationary gifts before
departure. If necessary, mainland participants gather in Jasper for those gifts;
upstairs members are never sent down. A missing imported kit fails initialization.
Archers use their source bow preference, falling back to a practice bow for an
explicit archer with no preference. Couriers retain all carried bows/arrows across
sales and can hand imported cargo to the upper runner. Skeleton drops remain with
hammer farmers until an archer requests them. The archer initiates stationary gifts
of arrows, food and healing/food reagents from those same-room donors, respecting
native carrying floors and protected/worn kit. The courier skips direct service
of a leased archer. This avoids competing with the trainee's own FleetScript.

No arrows waits up to fifteen minutes for ordinary resupply, then stops visibly.
Unknown or partial accepted gifts stop and leave a durable reconciliation record
under ignored `substrate/bow-supply/`; they are never resent automatically. Those
archer-initiated gifts have their own journals and are separate from the courier's
confirmed-delivery count. A worker stop request prevents new shots and trades;
accepted gifts and Mend work settle before leases are released.

The server's `skel4t.kod` treasure table includes silver arrows, whose class starts
with a ten-arrow stack (`slvarrow.kod`). Narthyl worms have no ammunition in their
treasure table. Both monsters are above level 99, so their level permits Fire and
Archery training through 99; actual learning also depends on the normal skill
checks and learning budget. Both resist piercing damage by 70%, so a bow trainee
cannot be assumed to replace a hammer farmer's kill rate.

Practice bows are sold by Kochtal ko'Tulca and plain arrows by Hanla zax'Ta on
Ko'catan. The confined Jasper couriers cannot purchase them on their current road
loop. Initial bows/ammunition must arrive through ordinary imports or available
stock; skeleton drops can supplement ammunition without guaranteeing continuous
training. Any Mend desk used by an upstairs trainee must be reachable within the
upper confinement; a mainland desk must not send the trainee down the ledge.

`node tools/m59-brax-archery-test.mjs` executes the real native sale dispatcher
offline, proving that ordinary loot still sells while carried bows and arrows
remain. It is not a live ArcherPlus qualification.
`node tools/m59-bow-supply-test.mjs` checks native receipt handling, source-floor
retention, stationary gifts, other-room deferral and no replay after uncertainty.
The private `_archerplus-brax-test.mjs --harness <owned harness checkout>` runs
against the actual private module to check upper-only Mend, stop and target/cover
selection. These are source/offline compatibility checks, not a new live farming
or health-gain measurement. A working safe spot and sufficiently close farmers
are still required in the actual room; no safe spot means no shot. An assist
health roll requires a landed hit, the same kill target at death, and monster
level above the archer's max health. A late arrow can miss the opportunity entirely.

## Validation and limits

`node tools/m59-brax-farm-init-test.mjs` is offline. It tests source retention,
role and pilot exclusions, policy/region differences, source identity, route
composition, post-release startup, launch ambiguity, worker lifecycle, scope and
concurrent movement issuers. Existing movement and supply tests cover the reused
lift, ledge trades, returns and delivery fallback. This packaged initializer has
not been executed on production or qualified by a new live hour. The previous
[farming measurement](reports/2026-10-19-brax-resupply-capacity.md) remains a separate,
confounded trial; the new Cooperative logoff tactic is installed separately.
