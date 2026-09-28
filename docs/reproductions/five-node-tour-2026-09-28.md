# Five-node loop rehearsal, 2026-09-28

Requested order: room 2 → Upstairs Castle Victoria → Under the shadow of the
Sentinel → Ancient Place → Badlands → Icky Cave → room 2.

The [reusable recipe](../m59-node-tour.md) separates ordinary movement from
explicit local-shadow scene preparation. Only Marco's clone `shadow22` / `Vvvv`
is controlled, game `127.0.0.1:15959`, broker 8971. All scene and command receipts
are local ignored files under [`substrate/node-tours`](../../substrate/node-tours).

## Complete circuit: one quiet-scene rehearsal passed

[`five-node-1790624002216`](../../substrate/node-tours/five-node-1790624002216.json)
completed all 51 legs from **19:33:22 to 20:11:38 UTC**, 38 minutes 16 seconds.
Start and measured end were identical: **room 2 r21c3**, client x2560/y20992,
floor 8192, health 20/20, mana 65/65, connection revision 1. There was no manual
steering, maintenance placement or administrative healing during the route.
All five activations returned the distinct **already bonded** message. There
were no new grants in this tour; it used an already bonded clone.

| Node | Arrivals in tour-development receipts / complete final-version circuits | Actual final-run arrival (client units) | Route and objective status | Last tested checkout |
|---|---|---|---|---|
| Upstairs Castle Victoria | 2 / 1 | 39 r13c46, x46320/y12848, floor 2048 | Arrival and exit exercised; already bonded | `5e9572f` |
| Under the shadow of the Sentinel | 2 / 1 | 589 r45c32, x31760/y45088, floor 5024 | Arrival and west exit exercised; already bonded | `5e9572f` |
| Ancient Place | 2 / 1 | 579 r52c30, x29952/y52256, floor 5088 | Natural east entry and north exit exercised; already bonded | `5e9572f` |
| Badlands | 2 / 1 | 45 r63c46, x46080/y64448, floor 4096 | Canyon approach and return exercised; already bonded | `5e9572f` |
| Icky Cave | 3 / 1 | 27 r23c53, x53760/y23040, floor 1536 | Approach and corrected exit exercised; already bonded | `5e9572f` |

The development counts include different versions, starts and partial runs.
**None establishes three independent complete circuits of the final tour.**
The reader reports four attempts, two full starts, one complete circuit and
`repeatable_circuit: false`. Prior standalone Cave, Badlands and Ancient
repeatability remains documented in their dossiers; it does not transfer
automatically to this new connected recipe.

Evidence and identity:

- Checkout `5e9572f63021eb6220456b7496461408a5224295`; running broker
  `d956c50`, PID 26348; movement epoch `5e9572f63021`.
- Driver SHA-256 `00aaa98c792e0290e4db92707170809e3815ea9b8dc359f4de4f77d52722d1d0`.
- Rail SHA-256 `ea231e99658a73957a8c7026407b043a32d18ddadb7cfb56f1d975ad98fcad1e`,
  preserved in the run's `-rails.json` snapshot.
- [Scene before/after preparation](../../substrate/node-tours/quiet-scene-1790623997512.json),
  [ordinary command receipts](../../substrate/node-tours/five-node-1790624002216-commands.jsonl),
  [sampled road positions](../../substrate/node-tours/five-node-1790624002216-positions.jsonl).
  Each fine leg has its own `-commands.jsonl`, `-dry.txt` and `-follow.txt`.
  The main receipt links runtime cuts and retains each node reply and stable mana reads.
- [Cleanup](../../substrate/node-tours/five-node-1790624002216-cleanup.json)
  is `finished_in_room_2`, with no rescue. [Post-run scene check](../../substrate/node-tours/final-state.json)
  confirmed generation restored in every applicable itinerary room and only
  `shadow22` / `Vvvv` online on loopback 15959.
- [Focused test output](../../substrate/node-tours/tour-tests.txt): 17 passed.
  Rebuilt rails passed 13/13 route checks and 16,662 lattice steps, none skipped.
- [Reader output](../../substrate/node-tours/final-report.json) preserves every
  failed, interrupted and partial attempt listed below.

Floors here are geometry samples at the observed fine body point, not server
z telemetry. Hostile bodies were removed and generation disabled before the
route; NPCs remained. After the successful finish and lease release, keeper
upkeep moved within room 2 to r19c8. The clone was then held there at 20/20
health and 65/65 mana; [final hold receipt](../../substrate/node-tours/final-hold.json)
is separate from the measured route endpoint. No other roster was started or held.

A checkpoint saved the local scene without stopping anything. Both snapshots
were preserved under `C:/code/mindmap/maps/m59-harness/docker/lab-data/checkpoints/`:
`2026-09-28T20-13-00-standing` and `2026-09-28T20-13-00-checkpoint`.
The [checkpoint receipt](../../substrate/node-tours/checkpoint.txt) records the save.

## Remaining validation boundary and next experiment

No movement defect stopped the final circuit. For all five nodes the next
repeatability experiment is two more full `mana-node-tour-shadow` runs from
room 2 r21c3 with the same driver/rail hashes and independently prepared scenes,
including a controlled broker/keeper restart. Keep failed runs in the ledger.
Do not count the different-version partial replays toward that threshold.

Monster tolerance remains untested at every node: replay captured hostile-body
configurations with the same receipts before claiming an operational populated
route. Cave additionally retains the named **inferred-fall promotion gap**:
`nodes/cave.md` documents the keeper's `undeclared_fall` decision. Capture and
declare that exact takeoff/landing in a checked rail before promoting this
experimental shadow loop as production movement. Repeated first-time grants
would require fresh clones or node-bit resets; neither was done in this tour.

## Exploratory run and corrections

`five-node-1790621039582`, checkout `1ffbb9f`, broker `0bccf18`, started in room
2 at r5c44, client x44544/y4608, floor 8192, health 20/20, mana 65/65.
It connected Victoria, Sentinel and Ancient Place without intermediate placement:

| Node | Actual arrival | Interaction |
|---|---|---|
| Victoria | 39 r13c46, x46320/y12848, floor 2048 | Already bonded |
| Sentinel | 589 r45c32, x31760/y45088, floor 5024 | Already bonded |
| Ancient | 579 r52c30, x29952/y52256, floor 5088 | Already bonded |

All remained at 20/20 health and stable 65 max mana. Victoria's return through
38, Sentinel's west exit into Ancient, and Ancient's north exit into 578 passed.
The entry into Ancient was the real crossing at r39c71/x72192/y39424/floor 6304,
not the staged start of the earlier node trials.

The run was **operator-interrupted**, not a complete circuit. After saved samples
showed room-576 travel oscillating near r111c70, a cancellation was sent. The
fresh pre-cancel read actually showed room 587 and the next travel to 586:
the room-576 crossing had already recovered. The `-stop.json` and
`-stop-classification.json` receipts retain this distinction; there is no claim
that room 576 is blocked.

Two driver corrections followed:

- The Badlands return must reuse the measured full 64-unit flood, whose
  1,031,495 points exceed `cutRail`'s 400,000 default cap. The tour now uses
  `floodReport` with cap 1,500,000 and the actual exit-square goal. The regression
  checks every returned edge from the measured node endpoint to r1c53.
- A broker `look.job` object can be a completed or cancelled receipt. Testing
  presence kept the interrupted tour polling until its four-minute bound.
  `travelJobActive` tests `job.busy`; regressions cover active, cancelled and
  completed replies. Boundary walks also stop on the observed destination room,
  keeping old-room coordinates from driving the body after a crossing.

`m59-node-tour-bake.mjs` reproduces the fine-rail dependencies offline. Rebuilt
Victoria, Sentinel, Ancient and Badlands waypoint arrays matched those used in
the exploratory run. Seventeen focused tour checks pass. Offline checks do not
establish a live loop; the append-only tour ledger is the source for full-run
counts, including all failures and partial replays.

## Partial replay from the road

`five-node-1790622360454` resumed experimentally at step 19, from room 587
r5c1, with broker `d956c50` / PID 26348. It crossed the roads, entered Kardde's
Canyon from the north on floor 6144, reached Badlands and received already bonded.
The corrected Badlands return passed, including the actual crossings 45 → 49 →
593, followed by the road through Cor Noth and the Icky Cave trigger.

Cave arrival was r23c53, x53760/y23040/floor 1536, health 20/20. Its immediate
activation reply contained no message and no mana increase; that interaction
remains **unknown** in the receipt. The attempted exit then reached r57c45
inside room 27 and stopped with `crossing_failed_room_587`. This was a script
composition error, `cave_exit_staging_is_not_crossing`: the earlier working
recipe walked to that staging square and then invoked `travel` to 587. The tour
now retains both operations, with a regression for the missing crossing step.

`five-node-1790623640202` replays from the cave's documented entrance,
r57c46/x46592/y57856/floor 2432 (partial start at step 41). It repeated the node
arrival. The immediate activation again returned no message, but a bounded
`wait_for_event` using the pre-activation look cursor **9341** received event
**9402**, `You have already bonded with this mana node.` The receipt retains
both responses. The tour now reads this fresh event window when an immediate
reply is inconclusive; it never searches old history to infer a new outcome.

That cave replay then completed every remaining leg: 27 → 587 → 576 → 587 →
597 → 598 → 599 → **2**. Its pre-cleanup end was r21c3, x2560/y20992/floor
8192, health 20/20, mana 65/65. It remains a **partial** replay, not a full loop.
The later complete rehearsal starts at that same normal return point.
