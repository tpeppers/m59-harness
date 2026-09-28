# Five-node tour from Outside Castle Victoria

`get-all-nodes` (also available as `mana-node-tour`) connects room 2 → Upstairs in Castle Victoria (39) → Under the
shadow of the Sentinel (589) → Ancient Place (579) → Badlands (45) → Icky Cave
(27) → room 2. It uses ordinary travel, checked fine rails, declared falls and
normal node activation. The cave leg still uses the keeper's measured inferred
fall, described in the [cave dossier](../.claude/skills/node-runner/nodes/cave.md),
so populated-server runs remain experimental. The operator explicitly authorized
production testing on 2026-09-28; this does not establish monster tolerance.
Administrative setup is confined to the separate
`mana-node-tour-shadow` lab recipe.

## Reusable acquisition FleetScript

Run one character at a time, starting in room 2, through the fleet REPL:

```text
get-all-nodes agents=hk3 expectedGame=76.214.42.186:5959
get-all-nodes agents=hk3 expectedGame=76.214.42.186:5959 getAll=true
```

The default reads the character's disk cache at the verified game endpoint. A
node is skipped only when its bit is present in **both** `mask` and `known_mask`.
Known absent and unknown nodes are attempted. `getAll=true` requests the full
supported circuit regardless of cached possession; `getAll=false` is also
accepted as a REPL string. An all-present cache produces a receipt with no
travel or activation. Cache skips remove the node detours, not just the meld
calls. Sentinel's exit still passes through Ancient Place when Ancient is
cached, using a passage that avoids the stone's meld box. Ancient alone uses
the existing north inbound rail and bypasses Sentinel.

The public script refuses multiple agents, keeps survival with the keeper,
verifies the selected keeper's deployed build before departure, attempts the
checked return on failure, and releases its lease. The serial production
campaign uses the same selector and planner; its CLI override is `--get-all`.
It additionally restores enchanters to their desk and has the measured castle
recovery fallback. The production campaign remains stopped at the documented
solo-survival blocker; this change does not dispatch or retry it.

Receipts retain the cache revision, positive bits, skipped observations, actual
visits and results. `selected_complete` means the selected acquisition finished
in room 2. `complete` still means all five approaches were actually exercised;
cache-covered or shortened runs cannot count as full-circuit repeatability.

### Downstream from node-runner

`m59-node-circuit.mjs` is the shared promotion boundary, not a copy of movement
logic. It consumes `STONES`/KOD bits and the existing fine router, declared falls,
checked rails, shelf follower, live objective checker and cache writer. The
rail bake records its catalog revision and `#movement` epoch; the acquisition
runner automatically rebuilds a missing or stale bake and checks selected rails
before leaving room 2. A refresh is offline validation, never a new live-success
claim. There is no scheduled background job or separate fork of the mover.

Currently **five nodes** are promoted. Seafarer's Peak, Ice Caves and conditional
or exempt nodes are not silently enabled by their presence in `STONES`. To
promote another solved node, update the shared catalog and circuit connectors,
bump `CIRCUIT_REVISION`, retain the node-runner receipt/dossier, and extend the
selection/route tests. The `get-all-nodes` name means all supported recipes.

Validation for the cache-aware compiler: all 243 three-state cache combinations,
all 32 selected subsets, a persisted-cache no-travel run against a fake broker,
and 14 checked rails / 18,335 lattice edges. The new Ancient transit and subset
connections are **offline checked, not live verified**. The earlier quiet-shadow
full loop remains the live evidence for the unchanged all-five itinerary.

Prepare the fine-rail dependency offline:

```powershell
node tools/m59-node-tour-bake.mjs --out substrate/node-tour-rails.json
node tools/m59-noderails.mjs check --file substrate/node-tour-rails.json
```

The baker selects the existing Victoria, Sentinel and Ancient rails, then uses
the measured 64-unit exact-endpoint Badlands flood (cap 1,500,000). Its output is
an offline candidate, never live reachability evidence. The Canyon and return
rails are cut and checked from the actual body's fine point at run time.

With the correct fleet, roster, `M59_CONTROL_URL`, shared run-lock directory and
broker build established, run through the fleet REPL:

```text
mana-node-tour agents=<agent> railFile=substrate/node-tour-rails.json getAll=true
```

The body must start in room 2. A held FleetScript lease covers the whole circuit.
Every node requires an actual room and position inside its 5×5 meld box before
activation. First meld, already bonded, dead node and unknown replies remain
separate outcomes. A completed route does not imply five new grants.

The lab recipe is scoped to the existing local Marco clone `shadow22` / `Vvvv`
on loopback port 15959. It removes hostile bodies and disables generation in
the itinerary rooms, heals only to the existing ceiling and places the clone
in room 2 at the normal western arrival, r21c3, **before** starting. This also
tests the room-2 approach from the point where the loop returns. It restores generation after the attempt and
rescues to Familiars after a failed route or partial debug replay. A complete successful route ends in room
2. Quiet-scene evidence does not establish monster tolerance.

`fromStep` and staging parameters on the lab recipe support a measured partial
replay while debugging. A partial replay never counts as a complete circuit.

Receipts live under ignored `substrate/node-tours/`: actual per-leg positions,
command replies, scene snapshots, code and rail hashes, node messages, same-
keeper mana readings and separate cleanup records. Inspect them with:

```powershell
node tools/m59-node-tour-report.mjs substrate/node-tours/tours.jsonl
```

Three independent complete circuits with the same code, rail revision, starting
point and scene condition are required before the reader reports repeatability.
Failed runs remain in the append-only ledger.

## Production campaign and node beliefs

`m59-node-campaign.mjs` saves a queue, controls one character at a time through
FleetScript's existing locks and faculty leases, and returns enchanters to the
room-2 post before releasing them. It preserves their policies and service
settings; designated enchanters return to their saved room-2 service assignment.
Active errands and human-piloted
characters wait. A failed route or unconfirmed node stops the campaign after a
bounded ordinary return attempt; `--retry <agent>` requires deliberate review.
No administrative game connection is used by this runner or its recovery.

```powershell
node tools/m59-node-campaign.mjs --plan substrate/node-campaign/prod.json --fleet prod --port 8901 --priority hk3,t9 --expected-game <game-host:port>
node tools/m59-node-campaign.mjs --run substrate/node-campaign/prod.json --fleet prod --port 8901 --limit 1
```

The priority agents are operator-local choices, not embedded defaults. Their
post is room 2 r19c8; review that field in the saved plan before starting. Other
characters finish in room 2 and their existing director resumes their duties.
Before departure the runner checks the selected keeper's recorded build. If
needed, it restarts only that keeper in room 2, waits for the existing broker
to respawn it, verifies the loaded commit, and renews its faculty lease. Other
keepers continue their jobs. Fineclimb's remote mode requires the exact `--expected-game` endpoint,
agreement between roster and live broker, and a checked declared rail.

The tour updates `substrate/node-memory/` after a confirmed `melded` or `already`
reply (or the supported stable same-keeper mana-grant evidence). It records the
KOD `piNodelist` mask, a `known_mask`, timestamps, receipt paths and correction
history, keyed by server endpoint plus character name. These five nodes are
`0x001f`. Missing bits are unknown until observed; a dead node, silence, range
refusal or login mana comparison cannot establish absence or possession.
The cache is a belief, never an authoritative live-server query. Acquisition
skips positively cached nodes; `getAll=true` forces re-observation. Other game
activity may make a belief stale, so invalidate it when that is known or suspected.

```powershell
node tools/m59-node-memory.mjs read --server <game-host:port> --character "Character Name"
node tools/m59-node-memory.mjs forget --server <game-host:port> --character "Character Name" --mask 0x1f --reason "External reset suspected"
node tools/m59-node-memory.mjs set --server <game-host:port> --character "Character Name" --mask 0x1f --reason "Operator observed the complete KOD mask"
```

`set` replaces the whole belief, including removals; `forget` marks selected
bits unknown. Neither changes the game. Files are ignored, atomically replaced
under per-character locks, and corruption fails visibly rather than resetting
the mask. `M59_NODE_MEMORY_DIR` selects a shared runtime directory across
checkouts. A surviving lock after a crash requires inspection; it is never
silently stolen. Focused tests: `m59-node-memory-test.mjs` and
`m59-node-tour-policy-test.mjs`.
