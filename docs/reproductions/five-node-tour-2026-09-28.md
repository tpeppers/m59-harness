# Five-node loop rehearsal, 2026-09-28

Requested order: room 2 → Upstairs Castle Victoria → Under the shadow of the
Sentinel → Ancient Place → Badlands → Icky Cave → room 2.

The [reusable recipe](../m59-node-tour.md) separates ordinary movement from
explicit local-shadow scene preparation. Only Marco's clone `shadow22` / `Vvvv`
is controlled, game `127.0.0.1:15959`, broker 8971. All scene and command receipts
are local ignored files under [`substrate/node-tours`](../../substrate/node-tours).

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
the exploratory run. Sixteen focused tour checks pass. Offline checks do not
establish a live loop; the append-only tour ledger is the source for full-run
counts, including all failures and partial replays.
