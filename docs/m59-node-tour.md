# Five-node tour from Outside Castle Victoria

`mana-node-tour` connects room 2 → Upstairs in Castle Victoria (39) → Under the
shadow of the Sentinel (589) → Ancient Place (579) → Badlands (45) → Icky Cave
(27) → room 2. It uses ordinary travel, checked fine rails, declared falls and
normal node activation. The cave leg still uses the keeper's measured inferred
fall, described in the [cave dossier](../.claude/skills/node-runner/nodes/cave.md),
so populated-server runs remain experimental. The operator explicitly authorized
production testing on 2026-09-28; this does not establish monster tolerance.
Administrative setup is confined to the separate
`mana-node-tour-shadow` lab recipe.

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
mana-node-tour agents=<agent> railFile=substrate/node-tour-rails.json
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
The cache is a belief, never an authoritative live-server query, and never
causes the tour to skip activation. Other game activity may make it stale.

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
