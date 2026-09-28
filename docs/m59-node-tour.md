# Five-node tour from Outside Castle Victoria

`mana-node-tour` connects room 2 → Upstairs in Castle Victoria (39) → Under the
shadow of the Sentinel (589) → Ancient Place (579) → Badlands (45) → Icky Cave
(27) → room 2. It uses ordinary travel, checked fine rails, declared falls and
normal node activation. Administrative setup is confined to the separate
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
rescues to Familiars only after a failed route. A successful route ends in room
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
