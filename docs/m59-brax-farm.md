# Initialize standing Brax farming

Run **`brax-farm`** from the deployed checkout on the broker machine. This is a
finite initialization, followed by ordinary keeper farming and a managed courier
process. It does not run a one-hour experiment, clone characters or change the server.

First preview explicit roles without connecting to a broker or changing anything:

```powershell
node tools/m59-brax-farm.mjs plan --agents t1,t2,t3 --couriers c1,c2 --runner t3
```

Replace those example IDs with the intended automated actors. `agents` names
**1 through 25 farmers**; `couriers` names **two additional mainland characters**;
`runner` is **one of the farmers**, able to carry supplies and loot through the
caverns. No actor is inferred from a wildcard, wealth, religion or max HP. The
initializer refuses missing or human-piloted roles before taking their run locks.
An already active or unresolved supply-worker reservation also refuses a new run.

For production, after deploying the committed implementation and verifying the fleet:

```powershell
$env:M59_CONTROL_URL='http://127.0.0.1:8901/'
node tools/m59-which.mjs --fleet prod
node tools/m59-fleet-repl.mjs --fleet prod
```

Then in that REPL:

```text
describe brax-farm
dry brax-farm agents=t1,t2,t3 couriers=c1,c2 runner=t3
brax-farm agents=t1,t2,t3 couriers=c1,c2 runner=t3
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
   hammer-only. Food is a carrying minimum, not a protected item that cannot be eaten.
6. After every selected actor succeeds and the outer run releases its locks and
   leases, launch the managed supply worker once. A partial result is explicitly a
   failed initialization, not "somebody arrived, so the group succeeded". It does
   not start another worker or silently send missing actors through repeated lifts.

Farmers remain confined to **578, 826 and 827**, with the hard upper-component
anchor in 578. Couriers have the Jasper/568/lower578 road allowance and the separate
lower anchor. Confinement also applies to ordinary recovery. The upper farmer runner
uses 827–826–upper578 and back; the couriers never take the Ancient Place lift.
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
cycles, confirmed recipient-delivery event count, and errors. Stop ends new work
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

## Validation and limits

`node tools/m59-brax-farm-init-test.mjs` is offline. It tests source retention,
role and pilot exclusions, policy/region differences, source identity, route
composition, post-release startup, launch ambiguity, worker lifecycle, scope and
concurrent movement issuers. Existing movement and supply tests cover the reused
lift, ledge trades, returns and delivery fallback. This packaged initializer has
not been executed on production or qualified by a new live hour. The previous
[farming measurement](reports/2026-10-19-brax-resupply-capacity.md) remains a separate,
confounded trial; the new Cooperative logoff tactic is installed separately.
