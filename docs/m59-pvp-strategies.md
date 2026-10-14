# PvP strategy files

Split out of [`CLAUDE.md`](../CLAUDE.md). The code is [`tools/m59-pvp-strategy.mjs`](../tools/m59-pvp-strategy.mjs)
(the loader and the closed decision set) and the PvP-strategy section of `CombatMode` in
[`tools/m59-combat-mode.mjs`](../tools/m59-combat-mode.mjs) (the keeper's half). The guard is
`node tools/m59-pvp-strategy-test.mjs` (63, offline).

## What the operator asked for

> these strategy changes shouldn't be changes to the harness for everyone -- they should be changes to the
> harness that allow for modular PVP strategies (engage, flee, etc. -- each able to specify their own details),
> such that people can run fleets of bots that even each individually define their own PVP behaviors through
> privately mapped overrides. Leave the current behaviors as-is for the defaults. (2026-10-13)

So the repository carries the MECHANISM and no orders. It names no room, no enemy and no character. A fresh
clone has no assignment file, every keeper's strategy host answers null, and `CombatMode` behaves exactly as
`m59-pvp-rooms-test.mjs` and `m59-war-test.mjs` pin.

## The pieces

| | where | committed? |
|---|---|---|
| a strategy module | `substrate/pvp-strategies/<name>.mjs`, then `M59_PVP_STRATEGY_PATH`, then `substrate/pvp-strategy-dirs.json` `{ "dirs": [...] }` | no — orders |
| the assignment | `substrate/pvp-strategy-<fleet>.json` (`M59_PVP_STRATEGY_FILE`) | no — orders |
| the shape | `substrate/pvp-strategies.example/flee-to-room.mjs` | yes |

The first directory holding `<name>.mjs` wins, so a local file overrides a private repository's of the same
name — the farm-strategy rule ([`docs/m59-strategies.md`](m59-strategies.md#private-strategy-directories)).

The assignment is `{ "default": E, "agents": { "t9": E }, "characters": { "Camilla": E } }`, where `E` is
`"name"`, `{ "strategy": "name", "options": {...} }`, or `null`. Most specific wins (agent, character,
default); `null` stops the fall-through and means *the harness default* for that character. A menagerie host
is never given a strategy. The keeper re-reads the file and the module every 2 s, keyed on mtime: an edit
needs no restart.

## The contract

```js
export default {
  name: 'my-strategy',
  decide(moment, facts, options) { return { do: 'flee_to', room: options.room, hold_ms: 600000 }; },
};
```

**Moments:** `attacked_by_player` (a player's blow landed — `CombatMode.beginPvP`) and `player_seen` (a
non-fleetmate player is in the room — `CombatMode.scanForEnemies`, at most once per player per room per 5 s).

**Facts:** `moment, character, agent, room, player, hostile, basis, pvp_allowed_here, health_pct, max_health,
in_flight, flight_room, hold_room, now` — frozen.

**Decisions, a closed set** (an unknown one is reported in `status` and answered with silence):

| decision | what the keeper does |
|---|---|
| `null` / `'default'` | what it always did |
| `{ do: 'flee_to', room, hold_ms?, hold_orders?, max_ms?, why? }` | takes the body as survival (`pvp_strategy_flight`), cancels any journey or job, walks the validated router to `room` without asking the confinement, ends the flight on arrival and HOLDS there: `Autopilot.travel` refuses the keeper's own journeys out until `hold_ms` passes (explicit orders are let through, unless `hold_orders: true`, which refuses those too -- a director such as the DUM moves units with explicit `travel` and would walk a fled unit straight back out). A blow on the road does not restart it and a war engagement does not preempt it. A flight that does not arrive backs off 15 s |
| `{ do: 'engage', why? }` | lifts this character's own `pvp_rooms` refusal **for this room**, for 60 s (renewed by deciding again): return fire on a hit, the war response on a hostile sighting. The server's room flags, the safety flag and every refused-target memory still apply |

`decide` must be synchronous and fast. A throw, a promise or more than 25 ms (`M59_PVP_STRATEGY_MS`) is
silence and a strike; three strikes stand the module down until its file changes.

## What a strategy cannot do

- It is not asked about monsters, deaths or anything on the 1-second survival clock other than a player; the
  protected faculties stay the keeper's (`m59-unattended-test.mjs`).
- It cannot preempt an operator's `combat_order`, and it never turns safety off.
- It cannot say anything to anybody: no speech verb, by the playbook's rule that text on a shared server must
  be a literal somebody chose.

## Reading what it did

the keeper's `/state` (and `/action status`) → `combat.pvp_strategy`: the loaded strategy and file, its last decision, the flight
in progress or the last one (`outcome: arrived|stopped`, `end_reason`), the hold, any backoff and any error.
Every decision writes one `pvp_strategy_decision` combat line per (moment, room, player, decision), and a
flight writes `pvp_strategy_flight`.
