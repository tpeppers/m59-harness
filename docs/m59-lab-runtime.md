# Optional event-driven lab runtime

The lab runtime is an **additional entry point**, not a replacement for the production
broker. The existing broker, keeper loop, service commands, and production fleet remain
the default and do not adopt the lab scheduler or state adapter. The standard broker does
share the atomic fleet/account ownership primitives with the lab runner, but it does not
import the managed lab adapter.

The lab runner is deliberately conservative: it changes how a local test fleet is
scheduled and observed, but by default still speaks the ordinary Meridian protocol to the
ordinary server at normal time. A separate, isolated simulation-clock server build now
exists for explicit experiments; it is not selected by the lab runner, the production
service, or the ordinary Dockerfile. Its narrower boundary and current verification gap
are documented below.

## Safety boundary

Use a dedicated, explicitly named non-production fleet. Checking configuration is the
default/read-only operation; logging characters in requires `--run`:

```powershell
node tools/m59-lab-roster.mjs --fleet lab-one --check
node tools/m59-lab-roster.mjs --fleet lab-one --mark
node tools/m59-lab-runner.mjs --fleet lab-one --check
node tools/m59-lab-runner.mjs --fleet lab-one --run
node tools/m59-lab-runner.mjs --fleet lab-one --run --agents t1,t2 --control-port 8912
node tools/m59-lab-runner.mjs --fleet lab-one --agents t1,t2,t3,t4 --shards 2 --check
node tools/m59-lab-runner.mjs --fleet lab-one --agents t1,t2,t3,t4 --shards 2 --run
```

`m59-lab-roster.mjs` is the narrow migration helper for an already-created roster. It
refuses production-like names, live fleet locks, non-loopback endpoints, the ordinary
production port, mixed endpoints, and incomplete credentials. `--mark` changes only the
`credentials.lab_runtime` intent field using an atomic file replacement; neither mode
prints account names or passwords. It does not create accounts or make a copied roster
safe from concurrent use, so the runner's account leases remain authoritative.

`--shards` defaults to `1`. Always run the same selection with `--check` first: its JSON
shows the deterministic shard assignment without claiming ownership, forking a child, or
logging in. A configured partner pair is one indivisible assignment group and is always
kept in the same shard. The runner refuses a shard count above 32, above the selected
actor count, or above the number of independent actor/partner groups.

`--startup-concurrency` defaults to `2` and is a per-process limit: in sharded mode each
child may start that many logins concurrently, so the fleet-wide peak is at most
`shards × startup-concurrency`. Each shard gets a bounded initialization deadline derived
from the largest assignment:
`min(10 minutes, 30 seconds + 2 seconds × ceil(largest-shard actors / concurrency))`.
For example, 100 actors split evenly across two shards at concurrency 2 get 80 seconds,
which is above the protocol-pacing floor for 25 login waves per child.

Every selected roster entry must carry an explicit intent marker inside its credentials:

```json
{
  "t1": {
    "credentials": {
      "lab_runtime": true,
      "account": "...",
      "password": "...",
      "host": "127.0.0.1",
      "port": 15959
    }
  }
}
```

The marker lives in `credentials` because that object survives the existing broker's
roster rewrites; `Session.join()` ignores the extra key. It records operator intent only.
It is not authentication and does not prove that another roster file does not contain the
same account.

The runner refuses:

- an omitted fleet name;
- a fleet name containing `prod`, `production`, or `live` (a guardrail, not proof that a
  differently named fleet is safe);
- an ambient `M59_STATE_FILE` during `--run`;
- an ambient `M59_ACCOUNT_LEASE_DIR` during `--run`;
- a selected entry without `credentials.lab_runtime === true`;
- a selected entry without an explicit host/port or one configured for unmanaged `tick` mode;
- duplicate normalized account-and-endpoint identities in the selected set;
- selected actors that do not all name the same game endpoint;
- a selected partner plan with an omitted, unknown, self, duplicate, or conflicting actor;
- a `--shards` count that would require splitting a configured partner pair;
- a fleet whose broker/runtime lock indicates that another process owns it; and
- any `--time-scale` value other than `1` in version 1.

For `--run`, the roster is always the exact named path
`substrate/fleets/<fleet>.json`; the generic `M59_STATE_FILE` override is refused rather
than allowed to redirect a named run silently. `M59_ACCOUNT_LEASE_DIR` is also refused:
choosing another directory would split the one account-ownership namespace and permit two
runtimes to claim the same login. Tests inject `leaseDir` through the registry API instead.
Read-only `--check` may honor `M59_STATE_FILE` so offline tests can inject a fixture.
`--check` validates the selection without logging in, starting a keeper, or printing
credentials. It inspects the exact fleet lock, but it does not acquire or audit account
leases; that final atomic check happens only during `--run`, before the Meridian modules
load and before any login.

The roster lock protects one exact roster *path*. That matters because Meridian permits
one connection per account, but it is not by itself an account ownership guarantee: a
copied roster at another path can name the same login. The marker and within-selection
duplicate check also cannot detect that alias. Cross-roster exclusion belongs to the
runner's account-and-endpoint lease layer; a deployment must not describe the path lock or
the marker as proof that an account is unused elsewhere.

Before creating a lease, `AccountLeaseRegistry` audits live legacy locks and stale
pre-guard broker records in the standard `substrate` rosters. Unreadable or malformed
records fail closed. This is a migration aid, not complete discovery: standard CLI runs do
not discover custom roster paths, other checkouts, or other OS users. Do not target the
same accounts from multiple checkouts/users. A library caller may supply additional
`legacyRosterPaths`, but there is intentionally no CLI lease-directory override. There is
also a startup race if an old-code broker begins after the audit and therefore never
participates in leases. Migrate every old broker before treating leases as fleet-wide
exclusion.

New standard-broker fleet and account claims carry a bounded `guards` list of keeper PIDs.
A keeper receives token-only permits and refuses before constructing a `Session` or
logging in unless its PID appears in both exact claims. If the broker dies, a live or
uncertain keeper guard keeps those claims non-reclaimable. A broker restarting the exact
same roster may atomically adopt the dead guarded fleet claim and only account claims from
that exact predecessor whose guards belong to the fleet. Before clearing takeover lineage,
the live fleet-guard set must equal the union of live guards on the selected account claims,
with each keeper appearing exactly once. Account claims also bind an opaque fingerprint of
the actor slot and normalized character, and live keeper adoption rechecks the character
reported by `/health` when the roster names one. An intentionally unnamed bootstrap entry
continues by exact account, actor, and guarded-PID continuity. A removed, renamed, or
retargeted named entry therefore fails closed instead of orphaning or relabelling a
surviving keeper. Lab runtimes and copied/alias
rosters cannot use that path. Definitely dead guards may be ignored; uncertain liveness is
a refusal. Encoded lock records remain bounded to 4096 bytes.

Claims written before keeper guards are deliberately not auto-reclaimed: a dead broker
may have live legacy keepers. The lab runner never honors the broker's migration override;
`--check` fails closed when the selected roster has a stale unguarded broker lock, and
`--run` also audits account aliases. For the first standard-broker restart after upgrading,
confirm the exact fleet/roster and use `M59_ALLOW_UNGUARDED_TAKEOVER=1` once. For each
expected agent, that broker verifies `/health`, terminates the exact reported legacy
keeper PID, waits until it is positively dead, and only then starts a replacement that
must install both new guards before login. If the PID does not stop, replacement login is
refused. Remove the override after a successful migration. Never use it for a lab or
copied/alias roster, and never delete a live or guarded lock.

The lease-aware standard broker claims or safely adopts ownership before opening either
its HTTP or stdio listener. An unresolved conflict therefore prints
`broker ownership refused before startup` and exits with status 3 instead of serving an
empty-looking fleet.

For `--shards N`, the lab parent acquires the exact fleet claim and every selected account
lease before a child can log in. It does not import Meridian, construct a `Session`, or
load an atlas. Each child starts as a minimal IPC process carrying only its shard number
and actor IDs. The parent adds that exact PID to the assigned account claims first and to
the fleet claim last; it sends the private initialization permit only after every shard
has completed that authorization barrier. No account, password, or roster credential entry
crosses initialization IPC. The child instead reloads its assigned
actors from the exact named `state_file` and proves that their endpoint/account and opaque
actor/character fingerprints match the token permits before dynamically importing
Meridian. Character names may subsequently appear as ordinary projected game state; they
are not used to transport the roster's login credentials.

There is no lab-shard adoption path. On an orderly stop the parent asks each child to
close, waits for its acknowledged result, disconnects IPC, and, after a bounded deadline,
terminates only the exact child handle it created. If a child PID remains live or its
liveness is uncertain, fleet/account release refuses and ownership stays guarded. If the
parent dies, children shut down on IPC disconnect; until that death is positively known,
their guards likewise prevent a new lab or alias roster from reclaiming the accounts. An
unexpected shard crash, disconnect, or exit is fatal to the run: the supervisor requests a
bounded stop of every remaining shard rather than letting a partial fleet continue, and it
does not automatically restart or adopt the failed child.

When a control port is requested, the loopback-only control surface exposes
`GET /health`, `GET /state`, `GET /transitions`, `POST /transitions/ack`, and
`POST /stop`. Every route requires the unpredictable per-process bearer token exposed by
the control server's `token` getter:

```powershell
$headers = @{ Authorization = 'Bearer <token supplied by the runner>' }
Invoke-RestMethod http://127.0.0.1:8912/health -Headers $headers
Invoke-RestMethod http://127.0.0.1:8912/stop -Method Post -Headers $headers
```

The token is sent in the `Authorization` header, never a query string. Requests with a
non-loopback Host, a mismatched `Origin`, or cross-site `Sec-Fetch-Site` metadata are
refused as well. Loopback binding is a containment layer, not authentication. The runner
prints the control URL and ephemeral token on separate stderr lines when the server starts;
it does not put the token in the URL, `/health`, or `/state`. Treat stderr or any service
log that captures it as a secret-bearing file and restrict its ACL accordingly. This remains an inspection
and shutdown surface, not a second broker API.

## What is shared, and what remains per character

With the default `--shards 1`, all selected lab actors run in the parent Node process.
ES modules are instantiated once, so one lazy collision/routing atlas and its module-level
caches serve the whole selection instead of being parsed and retained once per keeper.
That is the lowest-memory mode and does not require a `SharedArrayBuffer`.

With `--shards N` above one, the parent remains a lightweight ownership, control, and
state-aggregation process with no Meridian import. It forks `N` hidden Node children, each
with its own V8 heap and one lazy atlas shared by the actors assigned to that shard.
Configured partners are co-located before groups are deterministically load-balanced.
There is no JavaScript heap or atlas sharing *between* shards: sharding trades extra static
memory for an independent garbage collector and a smaller synchronous-stall/crash domain.
It is still much cheaper than one atlas per keeper when a shard owns several actors.

Module-level sharing is not, by itself, an immutability guarantee. Mutable caches are
shared by the actors inside one shard and must be audited for cross-actor interference.
All shards in one runner use the same named roster, runtime profile, and movement/map
epoch. `--shards` is not an epoch selector. Tests that require divergent epochs must use
separate runner invocations with separate dedicated rosters (and non-overlapping account
ownership), not two shards of one run.

Static route work is shared too. `m59-map.mjs` keeps passable-exit and BFS results in
per-map `WeakMap` caches, so alternate/test maps remain isolated and collectible.
For the lab profile, a current, complete routing bake also supplies frozen compact edge
topology and deferred step masks. Startup can therefore build the exact static graph without
decoding all 264 BSP trees; a room's `RoomGeometry` and mask are materialized together on
first real use. The shortcut is accepted only when manifest, bake version, mask predicate,
room number, dimensions, and room-resource security agree. Missing or uncertain evidence
falls through to the ordinary geometry decoder, while the production/default profile keeps
the eager warm unchanged.
`World.exits()` keeps the expensive static room/`.roo`/origin flood result in a per-atlas
LRU shared by the actors in that process (512 origins in the lab profile; the
legacy/default profile keeps its historical 24;
`M59_WORLD_EXIT_CACHE_CAP` overrides either). Dynamic portal objects are still read and
appended per actor, so one character never inherits another's live perception. Retiring a
refused inferred edge increments `routingRevision` and invalidates the static route caches.
This removes repeated multi-second flood work without sharing mutable session state.

The lab also reads `substrate/m59-exit-atlas.json`, a roughly 213 KiB projection of the
fine-BSP edge approaches that otherwise have to be derived on the first visit to every
direction of a room. It is not merely trusted because it exists. Its format and explicit
approach-predicate version, the complete map geometry manifest, and each room's number,
resource security, rows, and columns must agree. Candidate coordinates and staging squares
are schema- and bounds-checked before they enter a room-keyed `WeakMap`. A missing, stale,
or invalid atlas/direction falls through to `RoomGeometry.edgeApproachCandidates()` and the
ordinary live collision derivation. The default/production profile never registers the
atlas; `M59_EXIT_ATLAS=0` also disables it explicitly, while a path value selects another
atlas for an isolated experiment.

Rebuild the checked artifact after an edge-approach predicate or checked geometry change:

```powershell
node tools/m59-exit-atlas.mjs build
node tools/m59-exit-atlas.mjs status
node tools/m59-world-exit-atlas-test.mjs
```

The focused test re-derives all 264 rooms and compares all 3,346 approaches exactly, then
compares complete `World.exits()` projections for the stranded-boundary, conditional-edge,
large-room, and one-way-fall regressions. On this machine, hoisting the origin flood out of
the per-edge loop reduced room 576 from 85,350 to 17,070 grid expansions; adding the atlas
reduced a fresh-process call from about 1,501 ms to 113 ms. Room 545 moved from about
994 ms to 30 ms and room 599 from 505 ms to 19 ms. A new origin after shared geometry was
warm measured about 31 ms in room 576. These are CPU timings, not a promise about a loaded
host, but they remove the former multi-second boundary-validation maximum from the normal
lab path without changing its answer.

### Why the pauses were measured in seconds

The large maxima were not ordinary bot logic and were not primarily idle socket waits.
Reading and parsing the roughly 27 MiB map is part of cold start, but the retained cost is
CPU-side expansion: this checkout measured reverse-edge/collision construction at about
9.3 seconds, while the complete shared Session import took about 11 seconds. Separately,
the old `World.exits()` path documents 10–20 second origin flood fills in large rooms. That
expensive derived routing was reached from the two-second observation snapshot even though
the snapshot discarded everything except the exit destination and direction.

Each lab process registers the compact atlas once, lazily decodes only rooms gameplay
reaches, never calls enriched exits from routine observation, and shares immutable
per-map/per-origin results inside that process when gameplay requests them. The first
uncached room or origin still does synchronous work. `World.exits()` now builds its coarse
and mover distance maps once per origin rather than once per declared edge, and the checked
lab approach atlas removes the fine-BSP boundary derivation. A sufficiently large uncached
origin can still pause one shard for tens to low hundreds of milliseconds; other shard
processes and the parent control plane remain schedulable. With `--shards 1`, that one shard
is the whole lab selection.

Each character still owns the state that really is independent:

- one TCP socket and protocol decoder;
- its mutable session/client state and credentials;
- its controller, current action, deadlines, and error state; and
- its compact projected state record.

This keeps character behavior isolated at the API level while sharing large read-only
data and runtime infrastructure.

### Offline memory lower bound

The repository includes a no-login smoke measurement that imports the real atlas/session
stack and constructs real managed-autopilot shells without starting them or opening a
socket:

```powershell
node --expose-gc tools/m59-lab-memory-smoke.mjs --actors 100
```

On the current test machine after lazy topology and the exit atlas landed, three forced-GC
runs were stable at 137.3–138.1 MiB RSS and 59.6 MiB used heap after the one shared import,
which took 437–455 ms. Constructing 100 unstarted `Session`/`ManagedAutopilot` pairs took
11–12 ms and added 1.4 MiB used heap, about 14 KiB per shell; RSS movement was within
measurement noise. Two separate clean eager-profile imports took 6.45–7.03 seconds and
retained 380.5–389.8 MiB RSS/188.7 MiB used heap. This demonstrates both that the static
module cost is paid once and that unused room geometry is no longer paid at all in the lab
process.
It is deliberately a lower bound, not a live-fleet total: connected protocol clients,
decoded world/object state, inventories, action queues, and ongoing activity add
per-actor memory.

### Isolated live canary

On 2026-08-31 the same one-character, explicitly marked lab roster was run both ways
against a copied, loopback-only native server on `127.0.0.1:15959`; the production and
shadow brokers were not contacted. After startup settled, the shared runtime used
122.2–129.3 MiB of OS working set and 46.9 ms of CPU over a ten-second idle window. The
ordinary compatibility path used 263.7 MiB for the broker plus 463.5 MiB for its one
keeper—727.2 MiB total—and 62.5 ms of CPU over the same interval. That is an observed
82–83% live RAM reduction for this one-actor canary. It is not a hundred-actor capacity
claim: connected actor state still grows, while the ordinary broker's fixed cost is
amortized and each additional keeper adds another independent heap.

The standard broker also rebuilt its eager reverse routing table in 8.5–8.7 seconds on
each canary start. The lab process registered the same lazy graph in 0–1 ms and deferred
room geometry until first use. The authenticated control API returned its versioned
health/state projections and stopped the runtime with exit code 0; the fleet and account
claims returned to `free`. A separate forced-crash rehearsal left a stale exact-PID claim
that `--check` classified as reclaimable, and the next guarded start reclaimed it. The
standard broker then resumed the same roster as a verified keeper in its assigned
9411–9510 band and its orderly service stop removed both processes. Finally the isolated
server checkpointed with `terminate save` and stopped.

Roughly 138 MiB is therefore the current static lower-bound unit for process sharding, not
a fleet-wide constant. Four shards should be budgeted at roughly `4 × 138 MiB`, about
552 MiB RSS across the children before live sockets and actor state, plus the lightweight
parent. The operating system may share some executable/file-backed pages, but the runner
does not promise or account for that saving. Lazily decoded room geometry and derived
collision masks then accumulate independently in every shard that visits those rooms and
remain cached for that process lifetime. Use the smallest shard count that provides the
fault/stall boundary the experiment actually needs.

Before the game modules load, the environment adapter sets `M59_KEEPER=1` and redirects
the audited evidence paths it knows about—recordings, hits, intel, storage, ledgers,
postmortems, refused inferred exits (`M59_BAD_EXITS`), and the other paths enumerated in
`lab-environment.mjs`—beneath the exact roster's lab runtime directory. Universal movement
evidence that changes behavior immediately—safe spots, refused inferred exits, prey-side
sightings, and track strikes—is copied once from the configured/default source when the
private destination does not yet exist. Later writes update only the lab copy. In
one-process mode the actors share that writer tree. Sharded mode gives every child its own
`.../.lab-runtime/<roster>/shards/shard-N/` mutable tree because the pretty-write/replace
books are not cross-process safe. The explicit exception is cross-shard coordination:
all shards use the common `.../.lab-runtime/<roster>/coordination/spot-claims/` store,
whose claims are atomic and namespaced to the roster. These are per-runtime or per-shard
stores, not per-character stores.

This is path isolation, not a filesystem sandbox. A pre-existing symlink or Windows
junction beneath the runtime directory can redirect a write, and a newly imported module
that writes an unmapped default path can still escape that directory, so new persistent writers must be
added to and tested against the environment adapter before the isolation claim is extended
to them. The guarantee is deliberately limited to the explicitly mapped variables.

### Mutable-path audit

The audit follows the static import closure rooted at `runtime/meridian-actor.mjs` (Session
plus managed Autopilot), then checks the functions the actor path actually calls. A module
having a CLI writer does not make every read through that module an actor write. The split
is intentional:

| Path or book | Lab treatment | Why |
|---|---|---|
| `M59_TRACK_STRIKES` | Seeded, then private per process/shard | `Session.rideTrack()` calls `strikeTrack()` and `clearStrikes()` |
| `M59_TRACKS` | Shared/read-only | Actors replay the generated track book; only the offline `--save` command rebuilds it |
| `M59_CROSSINGS`, `M59_CROSSINGS_LEARNED` | Shared/read-only | `World` reads the merged crossing book; the lab actor path does not call `recordCrossing()` |
| `M59_LOADOUT_DIR` | Shared/read-only | Autopilot imports lookup/reconciliation predicates, not `writeLoadout()` |
| `M59_PLAYBOOK_DIR`, `M59_MERCHANTS`, `M59_GUILD_PLAN` | Shared/read-only | These are operator/generated inputs on the actor call surface; their writers are compendium/CLI paths |
| `M59_STRATEGY_STATS_DIR` | Private per process/shard | Managed Autopilot appends stats and vault snapshots |
| `M59_SPOT_CLAIMS_DIR` | Shared atomic coordination | All shards reserve safe-wall squares through the roster-namespaced file claim store |
| `M59_STRATEGY_DIR` | Unchanged | It belongs to the separate strategy-game web UI and is not in the actor import closure |
| `M59_NAV_LEARNED`, `M59_TUNING_FILE` | Unchanged | Neither module is in the current actor import closure |
| map, route, `.roo`, resource, spawn, spell, and code-exit inputs | Shared/read-only | They are authoritative/generated topology and protocol resources in actor mode |

Several of those modules export writer functions for maintenance tools. If a future actor
starts calling one, that call changes the classification: its destination must be mapped
before the new actor code is enabled. The offline environment test enumerates every mapped
key and verifies its resolved path is strictly beneath `runtimeDir`; it also verifies that
the shared/read-only inputs above are not rewritten by configuration.

## Wake-on-event scheduling

`SessionActor` replaces the managed autopilot's fixed-rate outer loop and watchdog
interval with an `ActorScheduler`. Client events mark an actor runnable; exact deadlines
cover reconciliation and pass-stall checks. Repeated ordinary wakes are coalesced, and an
actor has at most one decision running plus one accumulated rerun. The scheduler uses a
single deadline heap/native timer rather than one polling timer per keeper.

Safety work has a separate high-priority lane. Health loss, attack/disconnect events, and
the pass-stall deadline can wake that lane without waiting for an ordinary decision to
finish. Bounded starts per turn and a bounded safety burst keep one noisy character from
monopolizing dispatch. This is cooperative isolation, not an operating-system CPU quota:
a long synchronous JavaScript function can still stall the whole process. In default
one-process mode that means every selected actor. In sharded mode it means the actors in
that shard; for example, a multi-second synchronous `World.exits()` flood does not block
the parent or unrelated shard event loops, but it still blocks every actor sharing the
affected shard.

The normal lane permits one in-flight pass per selected actor because a pass can own a
minutes-long travel promise; treating that network wait as one of a small number of CPU
permits would let a few travelers starve the rest of the fleet. It still starts at most
eight actors per event-loop turn, and each actor still has at most one running pass plus
one coalesced rerun. The separate safety lane is capped at eight concurrent callbacks and
eight starts per turn. Ordinary policy wakes are additionally bounded by each autopilot's
`policy.decideMs` (one second by default); safety wakes bypass that cooldown.
Failed policy passes retain their pending reasons behind one keyed five-second backoff,
matching the legacy loop instead of turning a persistent exception into a hot rerun loop.

The central scheduler also measures how late its real deadlines fire. Its aggregate state
reports sample count, mean and maximum lateness, plus 1/5/20/100/500/2,000 ms buckets. This
uses the timer the scheduler already needs; it does not add a high-frequency event-loop
sampler whose own wakeups would distort an idle-fleet measurement.

Protocol `stat` packets always dirty the actor's cheap projected state, but they do not
all run the gameplay policy. A health decrease remains an immediate safety wake. For
upward/no-op health, mana, vigor, and bulk skill/spell stats, the actor compares the new
value with its previous compact vital snapshot: only crossing a configured policy line,
a casting/resting raw-value line, or a coarse fraction bucket creates an ordinary decision
wake. Same-bucket packets are state-only. This bounds regeneration and bulk-stat traffic
to a handful of passes while the keyed eight-second reconciliation deadline remains the
fallback for uncommon thresholds or a missed push.

The existing gameplay policy remains in `m59-autopilot.mjs`. The managed adapter changes
ownership of its outer loop and watchdog, then invokes the real decision pass when the
actor wakes. That keeps this experiment alongside the legacy runtime instead of forking a
second copy of all keeper rules.

## Cheap, slightly stale state

Routine observation projects only already-received primary facts: connection phase,
room and position, vitals, activity, and revision counters. It deliberately does not run
pathfinding, scan the world, serialize inventory objects, consult journals, or rebuild
derived threat state. Expensive diagnostics stay on an explicit cold path.

Ordinary observational updates use a coalescing delta channel. A slow consumer can skip
intermediate states and repair a sequence gap with an authoritative snapshot. The exact
acknowledged stream is deliberately limited to death, disconnect, closed, and reconnect
outcomes; it applies backpressure instead of silently evicting unacknowledged entries.
The one-process runtime permits 2,048 pending transitions per actor. In sharded mode the
child and parent defaults are 128 pending transitions per actor, with 4,096 total pending
in one child and at most 64 transitions in flight across its IPC channel. A long-running
consumer must read and acknowledge them; reaching a bound raises an explicit backpressure
failure rather than discarding an exact event.
`room-entered` is not duplicated there because the latest coalesced state is authoritative
for the current room. Consumers should therefore expect cached state to be briefly stale
while still receiving the selected critical transitions reliably.

Across a shard boundary, latest state uses a bounded, coalescing IPC window: a newer
unsent state replaces an older one, and parent acknowledgements release in-flight slots.
Critical transitions do not use that lossy rule. The child retains each sequenced event,
the parent rejects gaps and duplicates, and receipt alone is not an acknowledgement. An
ACK travels back to the child only after the parent-side consumer has read and explicitly
acknowledged the transition. Bounded child, wire, and parent windows apply backpressure
rather than evicting an exact event; a restarted child has a new stream ID, so a stale
cursor requires an authoritative state snapshot before resuming.

In the CLI profile, ordinary per-actor state is published at most once per second and the
aggregate fleet snapshot is rebuilt at most once per 250 ms. Safety-triggered state is
published immediately.

The standard production broker is demand-driven at the process boundary too. A
`KeeperProxy` owns no recurring rich-state poller. An agent-scoped MCP call materializes
that keeper's bounded snapshot before reading it, and the `fleet` tool materializes the
selected fleet on demand; bursts reuse each keeper's two-second value. A single recursive
broker deadline performs fleet liveness checks. It uses the keeper's projection-free
`GET /live` reply—agent, character, PID, connection flags, and connection revision—rather
than rebuilding room exits, objects, inventory, or GOAP state. A rich state read satisfies
the same liveness deadline. During a rolling upgrade, only an explicit 404/405 may fall
back to the older rich `/health`; HTTP silence plus a still-live recorded PID is unknown
and does not authorize reconciliation.

The standard one-process-per-character keeper also no longer rebuilds its enriched HTTP
status every two seconds in the background. `DemandSnapshot` gives `/health` and `/state`
a two-second maximum reuse window and rebuilds only for the next actual reader. Bursts
share one projection; an unobserved keeper has no snapshot timer. Reader-refreshed values
are coalesced into one trailing state-file write, without rebuilding the projection, and a
graceful exit constructs and saves one final value. The old unconditional 30-second
projection/write interval and its duplicate exit build are gone. This is especially
important because the enriched projection includes `World.exits()`.

Initial-login recovery no longer leaves a lifetime interval behind either. A failed join
owns at most one unreferenced 30-second retry timeout; another is armed only after that
attempt fails. Successful login, explicit leave/stop/rejoin, and process shutdown cancel
the pending retry. State persistence uses the same event-driven shape through
`DeferredLatest`: refreshed reader snapshots replace the pending value without replacing
its timer, and shutdown performs one final flush.

Keeper discovery is fleet-bounded too. Named fleets receive an atomically allocated,
non-overlapping 100-port band; actor offsets are limited to 0–99 and exhaustion refuses
to borrow a neighbour's range. The TUI and maintenance/recording tools resolve that same
registry, identify candidates through cheap `/live`, and read rich `/state` only after the
agent/character/PID tuple matches. A rolling-old `/health` is identity-only and is used
only after a definite `/live` 404/405; recording frames require `/state` with an explicit
age no greater than 2.5 seconds. A missing named band means no scan, never a fallback into
the unnamed or another fleet's ports.

`m59-service.mjs stop` now asks a current broker's loopback-only private control to
quiesce before considering a process kill. The broker closes the spawn gate, waits for
the reconcile/spawn lanes, sends addressed `/stop` requests to exact keeper identities,
and releases fleet/account ownership only when those lanes are settled. Rolling-old
brokers retain the verified-PID fallback; a current broker that accepts quiescence but
does not settle remains fail-closed unless the operator explicitly passes `--force`.

Two synchronous persistence loops were removed from ordinary policy frames as well. The
flight recorder now lives in `m59-recorder.mjs`; construction performs no filesystem work
and the first buffered event arms one one-shot flush for the burst. An idle or disabled
recorder owns no timer. Stranger sightings are durable encounter edges rather than frame
samples: unchanged room/object identity does no read or write, while first sight,
room/object transition, and leave/re-entry still append evidence. Empty frames only retire
the in-memory encounter marker.

The wire keepalive is deadline-driven as well. Each client owns at most one one-shot
timeout rather than a fixed interval. Successful ordinary outbound traffic moves the
20-second idle-heartbeat deadline without clearing or allocating another timer; inbound
traffic moves a separate proof-of-life deadline. A reply-producing inventory request is
still forced after at most 30 seconds without inbound evidence, leaving the existing
45-second ghost-session guard intact. A delayed event loop emits one probe rather than a
catch-up burst, and an idle, disconnected, or not-yet-in-game client has no ticking
interval.

## Clock boundary and isolated experimental server

The runtime modules provide real, scaled, and manually advanced clocks so scheduling can
be tested deterministically and future simulated-time components have an explicit clock
dependency. This is a local deadline abstraction only. Accelerating local sleeps does not
accelerate a network server, its world simulation, or protocol traffic.

Consequently the lab runner still accepts only `--time-scale 1`, and the ordinary
`m59-service.mjs`/`docker/Dockerfile` production-compatible path is unchanged. Local
`ScaledClock` tests are not evidence that an ordinary Meridian server runs faster.

There is now a **separate experimental server image** for an isolated lab. It is built
from the source-pinned artifact under `server-patches/simulation-clock/` through
`docker/Dockerfile.sim-clock`; neither the normal image nor `M59_ROOT` is patched in place.
Version 1 scales only the two event clocks that have an audited boundary: Blakod timers and
the Blakod-hour system event. Blakod `GetTime()` remains wall time because it also enforces
packet, movement, and speed-hack rates. TCP/session inactivity, protocol pacing, logging,
save cadence and names, channel maintenance, and profiling remain wall-clock operations.
Simulation therefore accelerates selected world waits without weakening anti-abuse timing
or pretending the whole process runs at the selected factor. Scale is a fixed integer from
1 through 100 for each image. Use the wrapper rather than hand-editing the native server
configuration; the wrapper is the supported path that validates and emits the canonical
integer value.

The check is the default and does not call Docker. The exact build command is an explicit
operator boundary:

```powershell
node tools/m59-sim-server-build.mjs --check --scale 10
node tools/m59-sim-server-build.mjs --build --scale 10 --tag m59-blakserv-sim:lab-10x
```

Set `M59_ROOT` to the manifest's exact pinned checkout or add `--source PATH`. The wrapper
verifies the repository/commit, all touched-source SHA-256 preimages, strict patch
applicability, and the resulting image labels. The Dockerfile repeats the source and patch
checks inside the build. It is deliberately separate from `tools/setup.mjs server`.

An image is run only through the loopback-only, resource-limited controller with an
explicitly lab-like name and non-production ports:

```powershell
node tools/m59-sim-server.mjs start --id clock-lab --image m59-blakserv-sim:lab-10x --scale 10 --game-port 15959 --admin-port 19998
node tools/m59-sim-server.mjs attest --id clock-lab
node tools/m59-sim-server.mjs stop --id clock-lab
```

The patched image requires a private guard marker and writes version-2 saves containing a
simulation-clock record; those saves belong only to that isolated runtime. Save/restart
preserves simulated time and each ordinary timer's remaining simulated duration. Live
`reload game` is refused for a simulation server because that path cannot restore the
clock safely. `stop` uses the server's `terminate save`, never a hard Docker stop.

Verification is intentionally reported in layers. The source contract tests pass 45
assertions, the controller integration tests pass 22, all 17 patched-source preimages and
strict application were checked, and a disposable Windows RELEASE build compiled and
linked with warnings treated as errors. The Docker daemon was unavailable, so the Linux
Dockerfile build, container start/attestation, and save/restart smoke were **not run**; no
live canary was run either. Until those commands pass on an isolated host, this remains an
experimental build artifact rather than a verified lab server.

## Module and API layout

The experiment is split at ownership boundaries so changes do not converge on one large
source file:

| Path | Responsibility |
|---|---|
| `tools/m59-lab-runner.mjs` | CLI safety checks, ownership, one-process lifecycle or shard supervision, and optional loopback control |
| `tools/m59-lab-shard-child.mjs` | Minimal waiting child; exits on parent disconnect and imports no Meridian code before verified init |
| `tools/m59-lab-memory-smoke.mjs` | Offline no-login shared-import and actor-shell memory lower bound |
| `tools/m59-lazy-geometry-test.mjs` | Offline exact-graph, bounded-decode, real-route, and deferred-mask regression |
| `tools/m59-exit-atlas.mjs` | Versioned lab-only fine-boundary artifact loading, validation, status, and atomic build |
| `tools/m59-world-exit-atlas-test.mjs` | Exhaustive approach parity plus representative `World.exits()` and cold-origin performance regression |
| `tools/m59-recorder.mjs` | Lazy, event-driven bounded flight recorder with no idle interval or constructor I/O |
| `tools/m59-room-artifacts.mjs` | Weakly keyed frozen topology and deferred step masks for the opt-in lab profile |
| `tools/runtime/lab-config.mjs` | Exact named-roster resolution, intent-marker and duplicate identity validation |
| `tools/runtime/lab-environment.mjs` | Pre-import keeper mode and audited mutable-path isolation |
| `tools/runtime/lab-game-globals.mjs` | Installs the selected roster globals after ownership/path validation |
| `tools/runtime/meridian-fleet-runtime.mjs` | Common single-process/shard construction of the generic fleet runtime |
| `tools/runtime/fleet-lock.mjs` | Atomic tokenized/guarded ownership and exact-broker adoption protocol |
| `tools/runtime/account-leases.mjs` | Endpoint/account leases, keeper guards, and read-only legacy-lock audit |
| `tools/runtime/control-server.mjs` | Authenticated loopback health/state/transition/shutdown API |
| `tools/runtime/fleet-runtime.mjs` | Fleet-level actor ownership, startup/shutdown, and aggregate state |
| `tools/runtime/demand-snapshot.mjs` | Timer-free bounded-staleness projection used by standard keeper HTTP state |
| `tools/runtime/deferred-latest.mjs` | One-timeout trailing coalescer for reader-driven keeper snapshot persistence |
| `tools/runtime/keeper-liveness.mjs` | Identity-checked rich-state/cheap-`/live` evidence and unknown-safe reconnect decisions |
| `tools/runtime/session-actor.mjs` | One session's event wiring, decision wakeups, safety lane, and reconciliation |
| `tools/runtime/managed-autopilot.mjs` | Adapter from scheduled decisions to the existing gameplay autopilot |
| `tools/runtime/primary-source.mjs` | Meridian-specific cheap primary-state source and safety-event classification |
| `tools/runtime/party-roster.mjs` | Pure selected-partner validation and in-process party-register installation |
| `tools/runtime/shards/index.mjs` | Stable public surface for ownership, transport, aggregation, and supervisor modules |
| `tools/runtime/shards/ownership.mjs` | Partner-preserving partitioning plus exact fleet/account child permits and guards |
| `tools/runtime/shards/meridian-supervisor.mjs` | Hidden child spawn, all-shard authorization barrier, private init, aggregation, and bounded exact stop |
| `tools/runtime/shards/meridian-child-runtime.mjs` | Exact-roster reload, permit verification, private environment, and post-verification Meridian import |
| `tools/runtime/shards/protocol.mjs`, `transport.mjs` | Versioned private-init/telemetry frames and injected IPC transports |
| `tools/runtime/shards/parent-controller.mjs`, `child-reporter.mjs` | Coalesced state, exact transition ACK/backpressure, health, and stop control |
| `tools/runtime/shards/fleet-aggregator.mjs`, `remote-transition-stream.mjs` | Parent-side fleet view and acknowledged per-actor transition streams |
| `tools/runtime/scheduler/` | Dirty-reason coalescing, deadline heap, priority/fairness, and dispatch |
| `tools/runtime/state/` | Immutable primary projection, snapshots/deltas, and acknowledged critical transitions |
| `tools/runtime/clock/` | Real, scaled, and manual clock primitives |
| `tools/runtime/runtime-profile.mjs` | Explicit legacy/production/lab profile and time-scale validation |
| `tools/runtime/server-clock-contract.mjs` | Source/patch/image/attestation contract for the isolated simulation server |
| `tools/m59-sim-server-build.mjs` | Read-only preflight or explicit source-pinned Docker image build |
| `tools/m59-sim-server.mjs` | Loopback-only guarded lifecycle and live clock attestation for one lab instance |

The generic scheduler, clocks, state channels, and session actor can be tested without a
live server. Meridian-specific construction stays at the edge.

## Test-first rollout and rollback

1. Create or select a disposable non-production fleet, stop its standard broker, run
   `m59-lab-roster.mjs --fleet <name> --mark`, and then run the lab runner's `--check`.
   Resolve every selection, profile, and fleet-lock refusal.
2. Ensure those accounts are not used by another roster. `--run` then audits standard
   pre-migration roster locks and atomically acquires endpoint/account leases before
   importing the game or logging in. Do not concurrently start an old-code broker, and do
   not target the same accounts from another checkout or OS user. Embedded library callers
   can add custom legacy roster paths, but standard CLI runs cannot make another checkout
   participate in this namespace. If
   `--check` reports a stale unguarded broker record, do not bypass it with the lab; migrate
   the original standard broker as described above.
3. Start a small agent subset with the default `--shards 1`; compare memory, event-loop
   lag, decision throughput, reconnect behavior, and state-stream correctness with the
   legacy test fleet.
4. If fault or synchronous-stall isolation is needed, run the exact proposed
   `--agents ... --shards N --check`, inspect its partner-preserving assignment, then repeat
   it with `--run`. Compare total child RSS as well as the parent RSS printed by the runner.
5. Increase the subset or shard count only after offline scheduler/state/clock/shard tests
   and live safety behavior pass. Keep production on `m59-service.mjs` throughout the trial.
6. Stop the lab parent (or call authenticated loopback `POST /stop`) to roll back the
   experiment. Do not delete a guarded claim if a child is still live or uncertain.

The simulation-clock image is a second, independent experiment, not step 7 of an ordinary
lab rollout. Do not point a roster at it until its exact image labels and live
`show simclock` attestation pass, and do not reuse its version-2 saves with an ordinary
server. This checkout has not yet completed the Docker/runtime smoke described above.

The exit-atlas work passes its exhaustive 15-assertion test, routing (131), collision
(333), shared route/exit cache (24), lazy geometry (17), map sharing (8), and exact-exit
(13) suites. `m59-region-exit-test.mjs` currently remains at 19 passing and 3 failing
assertions: its old Icky Cave fixture requires the trigger pocket to be unreachable and
staged, while the current mover graph now reaches that pocket directly. The atlas does not
serve code-defined region exits and does not cause that changed answer; those three stale
expectations are recorded here rather than reported as passing.

There is no production data migration to reverse and no production broker restart in
this rollout. Stopping the lab runtime closes the actors it started; the legacy service
remains the recovery path. That statement does not repair an earlier account-alias error:
without a lease—or while an undiscovered/custom or concurrently starting old broker is
outside the lease migration—starting one-login-per-account Meridian sessions could already
have displaced sessions launched from another roster.

## Current limits

- Default `--shards 1` has one process-wide blast radius. `--shards N` confines an uncaught
  child fault, garbage collector, or severe synchronous stall to that shard's heap and
  event loop, but it does not provide CPU quotas or per-keeper isolation. The supervisor's
  fleet policy is deliberately fail-fast: an unexpected child crash/disconnect stops every
  remaining shard, rather than continuing a partial fleet. The failed child is not
  automatically restarted or adopted.
- Geometry is shared and lazily decoded only inside a process. Decoded rooms stay cached
  for that process lifetime; they are not memory-mapped, shared between shard heaps, or
  split into evictable regional working sets. A first visit or synchronous `World.exits()`
  origin flood can still pause one shard briefly; the checked lab atlas removes the measured
  multi-second edge-approach derivation, but the exact per-origin distance flood remains
  synchronous.
- One runner has one named roster and one movement/map epoch across all its shards. Actors
  that need divergent epochs require separate runs and separate dedicated rosters with
  disjoint account ownership; per-map `WeakMap` caches do not make `--shards` an epoch API.
- The normal server and lab runner still run at `--time-scale 1`, and sessions still use
  TCP/IP. The separate simulation-clock image accelerates only Blakod timers/world hour,
  has not completed its Docker/runtime smoke, and is not an in-process or decoded-message
  transport.
- The existing gameplay `pass()` is reused, so actions inside an awakened pass still carry
  some legacy paced awaits and synchronous book/config access. Version 1 removes the idle
  outer polling and observation path; it does not yet make every gameplay primitive native
  to events.
- Scaling beyond one machine would need a distributed ownership/control protocol. Reducing
  the current per-shard static floor further would need an explicit cross-process immutable
  atlas representation rather than the current one-atlas-per-V8 design.

Those are intentional version-1 boundaries. Start with one shared process and event-driven
wakeups; add the fewest shards that materially improve fault or stall isolation, and keep
the ordinary runner at `--time-scale 1`. Treat the isolated simulation server as a separate
test-first experiment until its Docker and live canary gaps are closed.
