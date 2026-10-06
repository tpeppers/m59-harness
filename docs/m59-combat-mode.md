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

Until the bot receives a confirmed player attack, low health ends the current encounter but retains the watch. Normal survival
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

### PvP survival recovery

A confirmed incoming player combat message, including a block, dodge, parry or
avoid, immediately switches the bot to `pvp_return_fire`. Exact player identity
comes from the server's player objects/online list; nearby players, outgoing
attacks and quoted chat alone do not establish an assailant.

This mode preempts farming, travel, shopping, shelter and healing, including
queued packets and a previously started recovery's raw reconnect. It repeatedly
attacks the assailant regardless of the ordinary HP floor or farming eligibility.
It keeps attacking in range even under a ground effect; approach movement still
uses collision and hazard checks. A server refusal or blocked approach is logged
and retried, without returning control to ordinary recovery.

Continuous return fire is the default; low HP does not trigger an automatic
logout. If a connection drops, the mode retains hostility and counters in the
keeper process, rebinds the exact player names after login, and resumes attacking
at the remaining HP. Reconnecting never certifies a safe healing location. The
mode ends on death, explicit combat stop/connection suspension, changed character
identity, or when **every known assailant is absent and at least 30 seconds have
passed since the last incoming player attack**. An assailant still present keeps
the mode active beyond 30 seconds. Another known assailant becomes the target
when the selected one leaves. It does not chase players across room boundaries.

During that danger window, monster cover is the next priority **only while every
known assailant is absent**. A recent server-confirmed damaging monster attack
and that monster still being present permit the ordinary closest clear,
unoccupied safe-wall selection. It is movement to cover, without invoking rest,
safe-wall logout or the healing routine. Already at a safe wall, the bot stays
alert there. Monster damage does not extend the player danger timer. A returning
assailant immediately revokes queued shelter movement and resumes player combat,
even while the previous movement call is still unwinding. A blocked wall search
keeps PvP ownership and retries at most once per second.

This cover approach uses the shared square router first, with the recovery
selector's occupied squares excluded, then retains the fine-movement fallback
for difficult wall pockets. Ordinary refuge approaches keep their existing
handover behavior. This avoids a demonstrated CV close-range oscillation that
ignored a valid detour around the monster.

`combat.pvp_survival`, postmortems and replay scene controllers retain the
decision ID, chosen time, last attack time/age, known assailants, attempted attack
packets, server-confirmed incoming/outgoing hits and defenses, reconnect count,
blocked reason and ending outcome. Counts belong to the PvP episode, starting
with confirmed incoming hostility; earlier proactive attacks remain in combat
recordings. Hit counts do not estimate damage dealt. The last ended episode
remains available for death investigation. Process restart does not restore a
live hostility episode; the durable standing watch remains, and new incoming
attacks establish a fresh episode. Scene replay rebases hostility timestamps and
maps recorded player names to the temporary stand-ins.

The same record includes `last_monster_hit` and `shelter`: start, selection,
arrival and interruption times, actual chosen refuge/path, monster evidence,
failure/interruption reason and attempt count. Shelter remains a phase of the
PvP survival decision; it cannot hand the body back to ordinary healing.

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

## Guild war: engage on sight, and the map fights together

`combat_order` is an operator's decision about one named player. A guild war is a standing
one about a whole guild, and it needs no operator on the path. 2026-09-30: 117 of prod's last
150 deaths were three members of the Human Resistance, each announced by the server as
"... slaughtered by Morpheus of the Human Resistance in guild combat." A guild-combat kill flags
nobody (`player.kod:4868`), so `mayReturnFire` answered "not flagged" to every one of them.

`tools/m59-war.mjs` is the war book. `CombatMode.observeWar` is the response, in each keeper
process, on the socket's own events:

| input | where it comes from | effect |
|---|---|---|
| `OF.ENEMY` (0x02000000) on a player | the server, on every object packet, set only for a MUTUAL war (`user.kod:2418`), also on invisible players | engage on sight |
| remembered membership | `substrate/war-<fleet>.json`, from "in guild combat" broadcasts, look replies and operators | engage on sight |
| an unidentified stranger | room contents | the room's look leader looks once; the guild line is remembered |
| a zone alarm | `substrate/war-alarms-<fleet>.jsonl`, appended by a keeper that is attacked or engages | every keeper in the SAME map joins the fight |

Every engagement is the existing PvP survival return fire (`beginPvP`), with `keepSafety`.
A mutual war passes `CheckStatusAndSafety` with safety ON (`player.kod:3803`), so safety never
comes off in a war. That is what makes remembering safe: a player who has left the guild is
refused by the server ("Good thing your safety was on"), the engagement ends, and the book
suspends that name for ten minutes (`markRefused`). The same rule now covers an operator's
`kill` order against a war-marked target.

**The latency path.** A same-room enemy reaches every keeper in the room in the same server
packet, so there is no coordination delay. An alarm is one `appendFileSync` and a `fs.watch`
wake-up (a 250 ms poll backs it up). The broker is not on that path.

**Switches.** It is on in every keeper process and off for menagerie hosts. `warResponse: false`
in a character's roster policy turns it off for that character, and `M59_WAR_RESPONSE=0`
turns it off for the process. It stays quiet on its own outside a war, because every input
needs the server's mark, a listed enemy guild, or a fleetmate's alarm.

```bash
node tools/m59-war.mjs                                   # the book
node tools/m59-war.mjs --from-postmortems substrate/postmortems   # learn from past kills
node tools/m59-war.mjs --declare "Guild" | --peace "Guild" | --member "Name" "Guild"
node tools/m59-war.mjs --alarms                          # recent zone alarms
```

**The guild-invite trick is not used.** An invisible player is still sent in room contents under
its real name (`user.kod:2551`), and a look at an invisible player is allowed (`user.kod:4376`),
so an invitation would reveal nothing a look does not. It would also put a real invitation in a
stranger's pack.

PvP *plays* (placement, timing, who musters where) are FleetScripts in the private repository's
`strategy/pvp/`, installed at `substrate/fleetscripts/pvp/` and listed by the fleet REPL.

## The swarm: a wedge behind you, through the doors you take

```bash
# the terminal's S key does this for you, launching your character through the proxy first
node tools/m59-swarm.mjs start  --leader t21 --fleet prod
node tools/m59-swarm.mjs status --fleet prod
node tools/m59-swarm.mjs stop   --fleet prod          # members walk back where they joined
node tools/m59-swarm.mjs stop   --here --fleet prod   # released where they stand
```

**Who is in it.** Whoever is in your room when you press `S`, plus any fleet character who later
walks into the room you are in. **Never a character under 30 MAXIMUM health** (operator,
2026-10-06), never a menagerie host, a war noncombatant, or a character a human client holds.
Every refusal is logged once with its reason in `substrate/swarm-<fleet>.log`. The 30 line is one
constant, `SWARM_MIN_MAX_HEALTH`, shared with the chat order below.

**What it does.** Each member's keeper holds a slot in a WEDGE behind you, a square apart,
oriented by the way you last walked. When you leave the room it takes the door you were last seen
beside, or failing that walks to the room the swarm last saw you in. It still focus-fires your
target and buffs, exactly as the warband always did. A follower never stands on your square, and
it follows only while nothing else owns its body: a fight comes first, and a body below its own
flee line is left to survival. Legs are paced to one a second and each has a deadline.

**It overrides lockdown for its members only.** A member follows you out of an inn or the hall,
because following you is the point. When the swarm ends (your client closes, or `stop`), each
member walks back to the room it joined from and is released there, so its lockdown posture
resumes where it was. Non-members are never touched.

**How it fails.** The driver holds each member's movement and work with a 60 s lease and a 20 s
heartbeat. A dead driver stops renewing, and within a minute every member is its keeper's again,
standing wherever it is. That is a member stuck where the swarm left it, never one walking off.

**Before 2026-10-06**, `S` claimed every in-game character everywhere with a 120 s lease nothing
renewed, and nothing moved them: the fleet froze in place and the swarm silently ended after two
minutes. The argument for each piece, and the four bugs a two-keeper lab rehearsal found, are in
`tools/m59-swarm-follow.mjs` and the follow tick (`CombatMode.swarmFollowTick`).
`node tools/m59-swarm-follow-test.mjs` (11) pins the rules.

**"follow me" in chat is a different, older order** (`m59-follow.mjs`, `passFollow`): every fleet
member in the room who hears it walks your trail. It is not the swarm, and it ignores lockdown.
Since 2026-10-06 it too is ignored by anyone under 30 maximum health, after it walked Loial (20)
off his post, Marco Polo (20) across town and Raphael (25) into the Twisted Wood. "stop" ends it.

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

For proactive orders that have not become PvP survival, the controller checks health, connection, player identity and expiry on incoming
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
