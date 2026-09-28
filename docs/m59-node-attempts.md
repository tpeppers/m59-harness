# Repeating a mana-node experiment on the local shadow

`tools/fleetscripts/node-trial.mjs` is a bounded **lab experiment**, scoped to
`shadow22` / `Vvvv` on loopback game port 15959. It runs under FleetScript's
keeper leases. It refuses a different identity. Do not use it on production.

Setup heals to the character's existing ceiling, optionally removes hostile room
bodies and disables their generation, then uses `UtilGoNearSquare` **before** the
measured route. The actual starting point is read afterward. Generation is restored
and the character is rescued to Familiars after the attempt. That rescue is never
counted as a successful walking escape. The quiet scene is a condition of the result.
The recipe does not edit terrain, node state, attributes or maximum health/mana.

The recipe accepts `node`, `room`, `row`, `col`, `route`, `exit`, and `quiet`.
Routes are `coarse` (one bounded normal walk), `rail` (existing checked node rail),
`cave-entry` (576 → 587 → 27 → stone, then 587 → 576), and
`badlands-canyon` (body-seeded checked rail in 49, ordinary south exit, checked 45 rail).
Fine routes disable opportunistic hops. An incomplete rail fails before movement.

Use the repository FleetScript runner with an explicit shadow roster and
`M59_CONTROL_URL=http://127.0.0.1:8971/`. The local session's ignored
`substrate/run-node-trial.mjs` wires those values to its one-character roster.
Do not copy credentials into a recipe. Set `M59_TRIAL_BROKER_SHA` only after
checking the running process's deployment; it is an operator attestation, not a
hash magically recovered from the running process.

## Receipts

Runtime evidence is appended to `substrate/node-attempts/20260928/attempts.jsonl`.
Each row has format `m59-node-attempt/1` and includes:

- `at`, `stone`, `room`, `agent`, `fleet`;
- `checkout_sha`, `broker_sha`, `broker_pid`, `movement_epoch`;
- `route_ref` with recipe/follower content hashes; `scene_ref` with room bodies,
  generation state before and after setup; `setup` and `independent_reset`;
- `start` and `end`: room, row, col, `x_client`, `y_client`, `floor_client`, vitals,
  and connection revision where available;
- `navigation`: `reached_box`, `stopped`, `left_room`, or `died`, last leg and predicate;
- `objective`: `melded`, `already`, `dead_node`, `out_of_range`, `unavailable`,
  `untried`, or `unknown`, plus evidence filename;
- `escape`, `recovery`, and any failure or discovery.

Positions use named fields. Client units are 1024 per square. The follower's raw
`walk_to` replies carry protocol coordinates, converted using `m59-finepos.mjs`.
Floors are exact `.roo` samples at the body point, not server altitude telemetry.
Command receipts, sampled positions, dry-run output, scenes and activation replies
live beside the ledger. They are ignored runtime data, not files to commit.

`node tools/m59-node-attempts.mjs <attempts.jsonl>` gives a conservative summary.
Three distinct reset scenes must share the route/code epoch, broker revision,
documented actual start and quiet-scene condition, and actually end inside the
5×5 meld box. A successful FleetScript result means the experiment completed;
it says nothing about whether navigation or activation succeeded.

First-time melds require the distinguishing server message or a stable max-mana
grant within one keeper connection. `already` is an interaction observation,
never a second grant. Do not combine pre-login and post-login ceilings. The reader
does not turn a single meld into three first-time melds.

## Reusable exact-point diagnostics

```powershell
node tools/m59-ground.mjs --room 579 --from-client 30736,38432 --to-client 30480,38384 --stride 64
node tools/m59-ground.mjs --room 45 --flood --from-client 53856,992 --to r63c46 --lattice 64
node tools/m59-node-rail-import.mjs flood.json badlands rail.json
node tools/m59-fineclimb.mjs --fleet shadow-mana --port 8971 --agent shadow22 --rail badlands --rail-file rail.json --no-hop --dry-run
```

The flood records only exact trace arrivals. A slide that moves partway cannot
stand in for the requested lattice vertex. The importer rechecks the dense path
and retains the existing noderails proof/aim format. A successful import remains
an offline candidate. The follower must be exercised from its starting shelf.

For a zero flood, compare at least two resolutions and check whether the search
hit its cap. For a split square, record the actual fine floor. The Peak square
r38c25 illustrates why: its centre's floor is 12432, while the measured body
at client (25552,38304) stood on model floor 5056.
