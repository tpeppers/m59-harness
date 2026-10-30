# The muster — from a cold fleet to a launch, decided before anybody moves

```bash
node tools/m59-preflight.mjs avar-village --fleet shadow     # "preflight the avar village" (M59_CONTROL_URL=http://127.0.0.1:8971/)
node tools/m59-preflight.mjs avar-village --fleet prod       # the same questions of production — it only reads
node tools/m59-preflight.mjs --list                          # the musters this machine has
# then, in the fleet REPL for that fleet:
muster-run muster=avar-village accept=release_lockdown        # fire the plan; hands the ready ones to avar-village
muster-run muster=avar-village accept=release_lockdown launch=false   # stop at "ready"
```

Operator, 2026-10-29: production has to go smoothly when it runs the Avar Village, so the launch is worked out on the
shadow clone first, **from prod's real cold state**, and what comes out is a plan prod can run. The cold state that day:
every body locked to a no-combat room by `inn-lock` (whose saved "before" was the farm), ten `second-wind-drill` jobs
cycling survival off, tripwire-paused solo errands over would-be participants, and food in two packs. The first shadow
run straight into `avar-village` lost five at the inn door to survival-off and one on the road.

## The three pieces

| | |
|---|---|
| `tools/m59-muster-lib.mjs` | **pure**: readiness (every gap names its remedy, and a hazard when it is one), needs (meals by the game's Food tree; every reagent of every spell the muster wants cast, by kod class, from `substrate/m59-spells.json`), sources (packs, each character's vaults, guild chests, with rooms), the supply plan (self first, then nearest within `maxHops`; donors keep their own need plus a margin; what nothing covers is named) |
| `tools/m59-preflight.mjs` | **reads only**: keeper caches, the broker's `fleet` and `jobs`, posture saves, vault/chest caches, the room graph. Prints WHO / SETTLE / WHAT / HOW and writes `substrate/scratch/preflight/<muster>-<fleet>.json` |
| `tools/fleetscripts/muster-run.mjs` | **fires a plan**: settle (retire jobs over participants with `job_cancel`; each leaves its lockdown **to a hold**), survival on and the fight floor, hand-overs between two bodies in one room (retried after the rest), rest, a read-back check, then the operation |

A **muster spec** (`substrate/musters/<name>.mjs`, machine-local; ours come from the private repo's
`strategy/musters/`) says who, where, the thresholds, which spells how many times, what is required, the hop radius,
the operation, and the hazards it will need accepted. `substrate/musters.example/example.mjs` is the shape.

## Things it found that a hand-run would have argued about

- **Mushrooms are reagents.** The game's Food tree says so; a regex had counted 170 "meals" in one pack.
- **Spider eyes are food** (nutrition 9), and vaults hold hundreds — on the mainland.
- **Every cached vault had been read on the mainland**, none at Ko'catan's (2005). Vault caches now record the room
  they were read in (`by_room`); an older reading is placed by the owner's nearest fleet sample within three minutes,
  or left unplaced and said so. Preflight prints what exists **beyond** the hop radius rather than dropping it.
- **A plan is perishable.** `muster-run` refuses one older than `max_age_min` (15): drills toggle survival, people eat.

## What is not done yet

- Transfers that need a walk (a giver in another room within `maxHops`) and vault withdrawals are planned but not yet
  fired by `muster-run`; same-room hand-overs are.
- The lab's own vaults are not mirrored by the shadow clone, so on the shadow fleet vault sources are prod's cached
  contents under clone names (preflight says so).
