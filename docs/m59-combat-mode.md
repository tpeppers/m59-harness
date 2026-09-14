# Combat mode

Combat mode is an immediate, temporary behavioral override. It runs in the
keeper process that owns the game socket. The broker forwards a small addressed
command; it does not fetch a room snapshot, compile an errand, acquire a run lock,
or wait for the keeper's next normal pass. Fleet commands fan out concurrently.

The operator chooses the player explicitly. Names match exactly, ignoring case;
there is no substring targeting or automatic selection of a player. Combat
never changes the character's game safety setting. The server can still refuse
an attack because of safety, sanctuary, PvP rules, range or line of sight. A
safety refusal ends the order and appears in its status. Counts measure packets
sent, not hits or kills; server outcome messages are reported separately.

## FleetScratch

```
combat attack "Player Name" agents=t1,t2
combat ambush "Player Name" agents=t1 map=38 at=r10c20
combat ambush "Player Name" agents=t1 map=38 at=r10c20 door=r8c28 radius=1 ttl=600000
combat status agents=t1,t2
combat stop agents=t1,t2
```

These coordinates demonstrate the syntax; choose reachable positions and the
actual arrival area for the door you mean. `at=r10,c20` is also accepted. Other
movement commands keep their existing coordinate conventions.

`combat` has its own input queue, so it is accepted during a running `go` errand.
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
import { fleetCombat, attackPlayer, ambushPlayer } from './m59-fleetscript.mjs';

await fleetCombat({ agents: ['t1', 't2'], order: attackPlayer('Player Name') });

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
fields. Actions are `attack`, `ambush`, `status`, `stop`. `stop` optionally takes
`order_id`, so a delayed cancellation cannot stop a newer order. Direct keeper
requests use the existing addressed `/action` envelope with `name: 'combat'`.

## Trigger and lifecycle

An attack starts against the named, visible, attackable player in the current
map. An ambush travels to its map through the normal validated router, takes
the requested square, then becomes `armed`. It fires on that player's next
server CREATE/appearance event in this room. An optional `door` restricts the
arrival to a radius around a named square in the destination map. The protocol
does not tell us which source door caused an appearance, so this is an arrival
area filter, not proof of the player's route.

An already-present player, a room-content refresh, and an arrival before the
ambusher reaches position do not fire the ambush. The order then pursues the
exact player in the same room, taking short validated steps and re-evaluating
the target. It ends if the target leaves; it never follows a player through an
unknown exit. An armed character displaced from its selected position ends the
ambush rather than firing from the wrong spot.

Default lifetimes are 120 seconds for attack and 10 minutes for ambush; the
maximum is 30 minutes. The default sequence repeats one attack. Sequences have
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
