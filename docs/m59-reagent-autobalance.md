# The reagent autobalancer

`tools/m59-reagent-autobalance.mjs` (pure planner and learner), `tools/m59-autobalance.mjs` (the CLI and supervisor),
wired into the keeper's town trip and farm-delivery courier. Guard: `node tools/m59-reagent-autobalance-test.mjs` (28).

Operator, 2026-11-04: decide **how many** spellcasting reagents a character takes out of town or the guild chest each
lap, for **practice** (as many casts as the lap's mana allows) or **maintenance** (the fewest casts that keep a list of
buffs live for the whole lap). The aim is a **zero-discrepancy lap**: the reagents reach zero just as the kill that fills
the pack to the town-trip trigger lands.

## Silence means the old behaviour

No `substrate/reagent-autobalance-<fleet>.json`, or no loop for a character, and nothing changes: no plan on the trip,
the same purchase requests, the same sale, the same triggers. A loop with `driver: "script"` (the default) is only read
by scripts and the supervisor. The keeper is touched only by a loop with `driver: "keeper"`.

## The files (all gitignored; the shape is `substrate/reagent-autobalance.example.json`)

| file | written by | what |
|---|---|---|
| `substrate/reagent-autobalance-<fleet>.json` (`M59_REAGENT_AUTOBALANCE_FILE`) | a person, or `m59-autobalance.mjs set` | the loops (`loops.<Character>`) and courier switches (`couriers.<Character>`). Re-read on mtime every 2 s, no restart. A file that will not parse keeps the last good orders and says so |
| `substrate/reagent-autobalance/<fleet>/<Character>.json` | the keeper or the supervisor | learned state per mode: `pack_minutes`, `use_per_minute`, `start_load`, the last 20 laps |
| `substrate/reagent-autobalance/<fleet>/courier-<Character>.json` | the courier keeper (or a script) | per recipient and item: failed deliveries, paused or not |
| `substrate/reagent-autobalance/<fleet>/run-<Character>.{pid,stop,log}` | `m59-autobalance.mjs run` | the supervisor's files |

**Why an orders file and not a policy key or a loadout field.** It is the same shape as the PvP reserve
(`m59-reagent-reserve.mjs`), which the keeper already reads per fleet through `session.reserveWho`: per-machine orders,
by character, re-read on mtime, live without a restart and without a broker schema change. A policy key would be a
three-file change (`KeeperProxy` rebuilds) and would be overwritten by DUM's pushes; a loadout field would have mixed a
learned, CLI-edited setting into a file the planner page writes.

## The estimate

* **Lap** = minutes until the fuller of weight and bulk reaches `sellAtLoad` (0.9) of `1700 + might*20`, from the
  departure load, at `kills_per_minute` (default 1) times the expected loot per kill: the room's drop tables
  (`m59-spawns.json`) restricted to `loot_only`, weighed by `m59-items.json`, **one treasure roll per kill assumed**.
  `loot_per_kill` overrides it. Capped at `max_lap_minutes` (600) -- an estimate's sanity cap, not applied to a learned lap.
* **Mana** per minute = 60000 / t, t = `(150000 + (25 - mysticism)*1000) * 200 / vigor / max_mana` bounded 1000..60000
  (player.kod CalculateManaTime :5645). At `vigor` 100 (the operator's figure).
* **Practice casts** = (max mana + regen x lap) / mean mana per cast, round-robin over the list, capped by `gap_ms`.
* **Maintenance casts** = 1 + ceil(lap / duration) per buff, duration = the mean of `random(D/2, D)` at spell power 0
  (persench/*.kod GetDuration), or the loop's `durations`.
* **Reagents** = casts x the kod's costs (`spellCost`). The pack must hold them at departure: a plan that does not fit
  under the trigger is cut in proportion and says so (`cut_to_fit`).

## The PvP floor is on top and always named

Every line reads `mushroom: 14 planned + 10 PvP reserve = 24`. The floor is `floorsFor(resolveReserve(...))` for the
spells the character knows; it is never usable, never learned, and "leftover" is counted above it. A spell whose reagent
the reserve holds in bulk (sapphires on prod, floor 100000+) is **un-plannable** and the plan says why.

## Learning

Per lap: did each reagent run out (the first observation below one cast above the floor) and when; how much was used;
how long the pack took to fill (or, for a lap the reagents ended, extrapolated from its fullness). The signed
**discrepancy** is minutes ran out before the pack filled (negative) or casts left over above the floor, in casts and
minutes (positive). `use_per_minute` and `pack_minutes` move halfway toward each lap's measurement, at most x2 or x0.5 a
lap; the next lap carries `use_per_minute x pack_minutes`. So amount and lap length are learned together.

**Hand edits win**: `pinned.<item>` (a usable amount) and `multipliers.<item>` (on the estimate) replace the learner for
that item until cleared. Every edit made with the CLI is logged in the loop's `edits` with who, when and why.

## The town lap (`shops`)
Operator, 2026-11-05: "do a full town lap at Barloque ... buy mushrooms at Joguer's herb shop". A supervisor bank trip
deposits, withdraws the plan's totals from the hall chests, and then BUYS whatever the chests could not supply, per
item, at the loop's shop: `shops: { mushroom: { seller: "Joguer", room: 104 }, herb: "Joguer" }` (optionally `withdraw: <shillings>, bank: <room>` to top a thin purse up first; the `buy` fleetscript:
find the seller, buy, verify by count, walk back to the hall). A refusal or a thin purse is logged and the lap goes out
with what it has; the learner sees the shortfall either way. No `shops`: nothing is bought, as before.

## Trip triggers (`trigger`)

| | ends the lap when | keeper | supervisor |
|---|---|---|---|
| `pack` (default) | the pack is at the trigger | the existing triggers alone, unchanged | `full_percent` |
| `first` | the reagents run out (practice: no listed spell castable; maintenance: ANY required buff) or the pack fills | a `trigger: "autobalance"` trip (purpose `autobalance`), not within 10 min of the last town service | same |
| `reagents` | only the reagents | the load/stack triggers are HELD while reagents last, **only when `overfarm` is on** to sift the full pack (its `avoid` list is the drop order); otherwise noted and not held | farm orders carry `overfarm {enabled, overfarm_percent: 400, avoid: drop_priority}` |

`cancel_on_empty` (supervisor / fleetscript loops) stops the loop when the reagents run out.

## Where it hooks into the keeper

* `openTownTrip` -- the plan is made once as a trip opens (`trip.autobalance`, ledger `autobalance_plan`).
* `purchaseRequests` -- on that trip only, each planned reagent asks for `total - held` (total = planned + PvP), which
  feeds both the guild-chest draw (`buyReagentsInTown` -> `withdrawFromStockpile`) and the counter (`shoppingPlan`).
* `saleLoadout` -- on that trip, the sale keeps the totals (a carry `max` is raised, never lowered).
* `continueTownTrip` completion -- `autobalanceLapEnd` scores the lap that just ended (ledger `autobalance_lap`),
  writes the learned file and opens the next lap. `declareInterest` (every pass) calls `autobalanceObserve`.
* `checkIfShouldSell` -- `autobalanceTrigger` for `first` / `reagents`.

A keeper restart loses the open lap (it is in memory); the next trip opens a fresh one.

## Couriers

`couriers.<Character>: { pause_after: 2, room_below: 0.85 }`. In the keeper's farm delivery (`prepareFarmDelivery`,
where the courier decides what to buy) an item a recipient failed to take `pause_after` times in a row (receiver full,
refused, no counter -- a failed walk does not count) is not bought for them until they are short of it AND their
declared pack is under `room_below`. With any courier configured, keepers add `pack` (fullness) to their board
declaration; without one the board is unchanged. A fleetscript courier (Zheng He's lap) adopts the same two calls:
`courierGate(state, { recipient, item, evidence: { need, pack } })` before buying and
`recordDelivery(state, { recipient, item, delivered, why })` after `supply`, with `readCourierState` /
`writeCourierState(courierFile(fleet, courier))`.

## The CLI

```bash
node tools/m59-autobalance.mjs status --fleet prod
node tools/m59-autobalance.mjs plan Scooter --agent t21 --fleet prod      # read-only: status + inventory
node tools/m59-autobalance.mjs set Scooter trigger first --by tp --why "try first" --fleet prod
node tools/m59-autobalance.mjs set Scooter pinned.mushroom 14 --by tp --fleet prod
node tools/m59-autobalance.mjs clear Scooter pinned.mushroom --by tp --fleet prod
node tools/m59-autobalance.mjs reset Scooter --fleet prod
node tools/m59-autobalance.mjs run Scooter --agent t21 --fleet prod       # the supervisor
node tools/m59-autobalance.mjs stop Scooter --fleet prod
```

`run` and `plan` refuse a broker whose `/health` names another fleet. The supervisor is the generalised
`scooter-cave.mjs`: it never sends while the character is piloted.

## A fleetscript adopting the hook

```js
import * as ab from '../../tools/m59-reagent-autobalance.mjs';
const { loop } = ab.loopFor(ab.readOrders(ab.ordersFile('prod')), { character: 'Scooter', agent: 't21' });
const plan = ab.planLap({ loop, known, mana: { max }, mysticism, reserve, capacity, startLoad, held, learned, spawns });
// withdraw plan.totals (log plan.lines -- they name the PvP floor), then:
let lap = ab.startLap({ plan, pack, fullness });
// every minute:  ab.observeLap(lap, { pack, fullness }); const v = ab.lapVerdict({ loop, lap, fullness });
// at the bank:   const r = ab.recordLap({ lap, end: pack, endedBy: v.by, fullnessEnd, learned }); write r.learned
```
