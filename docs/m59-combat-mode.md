# Combat mode

Combat mode is an immediate, temporary behavioral override. It runs in the
keeper process that owns the game socket. The broker forwards a small addressed
command; it does not fetch a room snapshot, compile an errand, acquire a run lock,
or wait for the keeper's next normal pass. Fleet commands fan out concurrently.

The operator chooses the player explicitly. Names match exactly, ignoring case;
there is no substring targeting or automatic selection of a player. Combat
leaves the character's game safety setting alone for attack/ambush. An explicit
`kill` temporarily turns safety off while engaging, restores its original on
setting while waiting or stopping, and retains restoration across a reconnect.
The server can still refuse
an attack because of safety, sanctuary, PvP rules, range or line of sight. A
safety refusal ends the order and appears in its status. Counts measure packets
sent, not hits or kills; server outcome messages are reported separately.

## Immediate chat orders

### Farm normally and swarm on sight

Use a standing farm watch when the target should interrupt farming only while
visible:

```
node tools/m59-combat-order.mjs "Kill Morpheus" --fleet prod --maps 39,544 --when-absent farm
```

This installs one passive watch on the automated fleet for Upstairs in Castle
Victoria (39) and the Valley of Ileria (544). It includes recipients that enter
either map later. Farmers sharing the target's map converge on the exact player
using the ordinary validated movement and attack pacer. Bots in other maps
continue their normal behavior; combat does not chase the player across maps.

While Morpheus is absent, normal farming keeps body ownership and its current
jobs. Appearance or visibility changes activate the local combat override.
Disappearance releases it, restores PvP safety when the order lowered it, and
allows normal farming to resume without another command. Each keeper acts on
its own current player visibility; an unseen object ID is never attacked blindly.

Low health ends the current encounter but retains the watch. Normal survival
and recovery continue, and the watch rearms after health reaches the greater of
80% and ten percentage points above the current survival floor, capped at 99%.
An already-hurt bot can accept a watch without fighting. Paused, held and
nonfarming keepers stay passive. Ordinary explicit combat orders still replace
a watch, and `stop` removes it; scoped stop accepts its `order_id`.

Watch configuration is saved per character under ignored
`substrate/combat-watches/`, bound to the exact roster, game endpoint and
character. It survives keeper restart and reconnect. This stores no account
credentials. Explicit stop is saved too. A server refusal or impossible approach
blocks the current sighting rather than repeatedly interrupting farming; a new
appearance can be tried again.

Status distinguishes active combat from a passive watch:
`active: false, watch: { enabled: true, phase: "watching" }` means normal farming
with the conditional order armed. Other watch phases include `engaging`,
`recovering`, `outside_map`, `paused` and `blocked`. Readiness reports whether the
recipient is currently eligible to farm. Broker/keeper capability version 3
includes standing farm watches.

FleetScratch:

```
combat kill Morpheus maps=39,544 absent=farm
```

FleetScript:

```js
await fleetCombat({
  rooms: [39, 544],
  order: killPlayer('Morpheus', { when_absent: 'farm' }),
});
```

Dispatch an urgent order before inspecting the fleet or writing a script:

```
node tools/m59-combat-order.mjs "Kill Morpheus" --fleet prod --room "Upstairs Castle Victoria"
node tools/m59-combat-order.mjs status --fleet prod --command-id <receipt-id>
node tools/m59-combat-order.mjs stop --fleet prod --command-id <receipt-id>
node tools/m59-combat-order.mjs --check --fleet prod
```

The kill example is syntax, not a standing order. Upstairs in Castle Victoria
is map **39**. The room alias resolves from the broker's loaded map. Each keeper
selects itself from its own current map before touching existing behavior.
Human-piloted characters and characters outside the selected map are skipped.
Selected units remain in that map; they do not follow sightings into other maps.
An absent or currently nonattackable named target produces a `waiting` receipt,
and the same intent waits again if the player vanishes.

The CLI makes one `combat_order` MCP call carrying the expected absolute roster
path. That identity check happens before dispatch in the same request. There is
no separate fleet/look/status preflight. Healthy keepers receive commands in
parallel; the broker uses a 200 ms window for initial receipts. A busy broker
event loop can extend that window, especially during startup. `pending` is
unconfirmed delivery, not acceptance. Query `status` by command ID to inspect
current keeper states, and use `stop` by that ID even if delivery is still pending.
Commands carry an ordering revision; late older commands and stopped command
IDs cannot resurrect an override. Transport failures are not retried.

Run `--check` during setup or after deployment. It checks deployed support and
connection state through cheap addressed keeper requests, without room snapshots.
Broker health and keeper liveness advertise `combat_mode: 3`. Update an old
deployment before accepting urgent instructions; deployment is not part of the
urgent command path. The command does not restart services automatically.

An offline regression with normal five-packet-per-second pacing measures roughly
620 ms from group dispatch to the first in-range attack packet. It allows 1500 ms.
Travel, server latency, cooldowns, health and geometry still constrain execution.
Chat interpretation time is outside that measurement.

## FleetScratch

```
combat attack "Player Name" agents=t1,t2
combat kill "Player Name" room="Upstairs Castle Victoria"
combat ambush "Player Name" agents=t1 map=38 at=r10c20
combat ambush "Player Name" agents=t1 map=38 at=r10c20 door=r8c28 radius=1 ttl=600000
combat status agents=t1,t2
combat stop agents=t1,t2
```

These coordinates demonstrate the syntax; choose reachable positions and the
actual arrival area for the door you mean. `at=r10,c20` is also accepted. Other
movement commands keep their existing coordinate conventions.

`combat` runs independently of the errand queue and other outstanding combat
receipts, so a slow request cannot delay a stop or a new order.
Combat orders remain in the keeper if the terminal closes, until they finish,
are stopped, or expire. Stop explicitly to end an ambush early.

For reusable complex actions, write a pure pad with `mode: 'combat'` and one
order in `steps()`, pin it to the usual scratchpad board, then use:

```
dry my-ambush agents=t1
combat run my-ambush agents=t1
```

`combat run` requires a posted combat pad and rejects setup/teardown phases.
Saving/reloading a pad never sends an order. Keep preparation errands separate
from the urgent order; an ambush handles its own travel and positioning.

## FleetScript

```js
import { fleetCombat, killPlayer, attackPlayer, ambushPlayer } from './m59-fleetscript.mjs';

await fleetCombat({ agents: ['t1', 't2'], order: attackPlayer('Player Name') });
await fleetCombat({ room: 'Upstairs Castle Victoria', order: killPlayer('Player Name') });

await fleetCombat({
  agents: ['t1'],
  order: ambushPlayer('Player Name', 38, { row: 10, col: 20 }, {
    door: { row: 8, col: 28, radius: 1 },
    ttl_ms: 600_000,
    repeat: false,
    sequence: [
      { do: 'cast', spell: 'hold', target: 'target' },
      { do: 'wait', ms: 200 },
      { do: 'attack', swings: 5 },
    ],
  }),
});
```

Alternatively use `fleetScript({ mode: 'combat', agents, steps: [order] })`.
`steps` can return a different order per agent. All declarations validate before
dispatch; one unreachable character does not prevent the others from receiving
their orders. Responses contain a result and order ID per character, and an
explicit error for each refusal. Transport failures are not retried automatically.

The helper sends the expected absolute roster path with the command. The broker
checks that against its own roster before dispatching, preserving the fleet
identity guarantee without an extra `/health` round trip. Run from the checkout
configured for that fleet, as with other fleet tools.

The equivalent MCP tool is `combat` with `agent`, `action` and the same order
fields. Actions are `kill`, `attack`, `ambush`, `status`, `stop`. `stop` optionally takes
`order_id`, so a delayed cancellation cannot stop a newer order. Direct keeper
requests use the existing addressed `/action` envelope with `name: 'combat'`.

## Trigger and lifecycle

An attack or kill waits for the exact named player to be visible and attackable
in the assigned current map, then starts immediately. CREATE, room contents,
movement and appearance changes wake the controller; a 100 ms timer is the
fallback. Numeric object IDs require a currently visible attackable player.
An ambush travels to its map through the normal validated router, takes
the requested square, then becomes `armed`. It fires on that player's next
server CREATE/appearance event in this room. An optional `door` restricts the
arrival to a radius around a named square in the destination map. The protocol
does not tell us which source door caused an appearance, so this is an arrival
area filter, not proof of the player's route.

An already-present player, a room-content refresh, and an arrival before the
ambusher reaches position do not fire the ambush. The order then pursues the
exact player in the same room, taking short validated steps and re-evaluating
the target. If the target leaves, queued target-dependent packets are revoked
and the order waits for that exact name to reappear, even under a new object ID.
It never follows the player into another map. An armed character displaced from its selected position ends the
ambush rather than firing from the wrong spot.

Orders remain until stopped, replaced, completed or interrupted by survival or
connection/room identity changes. There is no default timeout; explicit
`ttl_ms` is 1000 through 1800000. The default sequence repeats one attack. Sequences have
at most 16 attack/cast/wait actions; `repeat: false` finishes after one sequence.
Only spells already known to the character may be ordered. Cast targets are
`target`, `self`, or `none`. A cast holds the body still for `hold_ms` (default
1000; maximum 60000), including when it is the last action. Set this explicitly
for spells with a casting trance, for example `hold_ms: 15000` for blink.
The wire does not expose trance duration; the hold is an operator-specified
delay, not confirmation that the spell succeeded. Health and ground-effect
escape take precedence over concentration. Normal costs and cooldowns apply.

The order replaces current movement and fighting, and invalidates old queued
packets and asynchronous cleanup. Ordinary keeper behavior is suppressed while
combat is active. Existing standing policy and external faculty leases remain
in place for when combat ends; cancelled errands are not replayed. Combat
appears as the temporary owner of directional faculties, leaving the protected
faculties with the keeper.

The controller checks health, connection, player identity and expiry on incoming
events, a 100 ms fallback timer, and immediately before paced packets. Health at
or below the greater of `stop_below` (default 0.35) and the keeper's computed
survival threshold (falling back to `fleeBelow`)
ends combat and returns control to recovery. Unknown health, death, room or
connection changes also stop it, as does receiving no server data for 45 seconds.
There is no network call in this decision.

The pacer prioritizes combat work and removes superseded packets before they
consume a pacing slot. It preserves the configured packet rate and attack/cast
cooldowns. This minimizes response latency; it does not promise zero latency or
bypass server limits. Status exposes acceptance, arming, trigger, first packet,
first attack and completion times, plus measured trigger-to-first-attack latency.

## Firewalls and ground effects

`look`, render projections and the keeper room view expose `ground_effects`.
Individual World objects also carry `ground_effect`. These come from current
room objects, and disappear on server REMOVE or room reset; no guessed lifetime
can keep a vanished firewall on the map.

Recognized effects include firewalls, lightning walls, webs, brambles, and fog
clouds. Names/icons and movement-notify flags identify their observable type.
Fog and spores share wire appearance: poison versus active spores is ambiguous,
and ordinary fog versus passive spore/acidic fog is not declared safe. An active
fog's actual radius is unknown; avoidance reserves the possible three-square
spore radius. Unknown non-examinable movement-notify objects are reported too.
Caster, damage, immunity, true spell duration and line-of-sight coverage remain
unknown. The model does not claim that every nearby effect will damage us.

The ordinary walker includes hazard squares in its route planning. The final
validated movement sender checks the actual segment again after pacing, so a
newly appeared effect, a fine move, or a long coalesced step cannot silently
cross the hazard. A body inside an effect may move outward, while entry into a
different effect is refused. Combat and the ordinary keeper try to step out of
effects underfoot before continuing. This is conservative avoidance using the
normal collision model; it never relaxes geometry to escape an effect.
Direct tick-driver and diagnostic moves also pass a hazard check before sending.

Sources: `kod/object/active/wallelem.kod`, its `wallfire`, `wallltng`, `web`,
`poisfogc`, `asburstc` subclasses, `spell/walspell/sporbrst.kod`, the passive
fog classes, and `monster/BRAMBLE.kod` in the Meridian59 server tree.

Offline checks: `m59-combat-mode-test.mjs`, `m59-ground-effects-test.mjs`,
`m59-combat-integration-test.mjs`, and the existing packet-scope, combat safety,
survival, authority, movement and FleetScript/FleetScratch suites. No test
orders an attack against a live player.
