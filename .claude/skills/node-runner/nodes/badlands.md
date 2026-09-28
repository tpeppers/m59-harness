# badlands — NODE_BADLANDS, room 45, stone at r63c46

## 2026-09-28 update — read before the older conclusions below

The mesa is **not proved impossible**. Exact-endpoint floods from client
(53856,992), checked at 128 and 64 units, reach the stone's square on floor 4096.
The 64-unit search needs a cap above 400,000: it visits 1,031,495 points.
The imported candidate has 4,599 dense points, 361 driving aims, and all 4,598
edges validate with no skipped spans. This is an offline candidate, not live success.

The strict edge predicate matters. The old lattice helper accepted any moved
trace, including a slide that never reached the requested vertex. Measured at
room 45 wall 700: client (15776,18336)/2048 toward (16032,18272)/2432 slides
onto 1664. `m59-ground` now requires `arrived === true`; `m59-ground-test` keeps
the partial-slide regression. `badlands-wall700.json` retains the exact trace.

Reusable generation:

```powershell
node tools/m59-ground.mjs --room 45 --flood --from-client 53856,992 --to r63c46 --lattice 64 > flood.json
node tools/m59-node-rail-import.mjs flood.json badlands rail.json
```

The `node-trial` FleetScript's `badlands-canyon` recipe first cuts a fresh rail
from the body's actual position in room 49 to client (19488,26656), floor 6016.
It validates the cut, dry-runs the follower, follows with `hold_shelf`, crosses
normally into 45, then follows the strict room-45 candidate. Setup, route and
administrative rescue are separate receipts. The initial documented test shelf
is r22c11, client (10752,22016), floor 3840. Never treat r25c17 alone as proof
of arrival on the upper shelf.

Evidence lives under ignored `substrate/node-attempts/20260928/`; inspect the
ledger for the live outcome. No escape or meld claim follows from the bake.

## Historical attempts (superseded where the update above differs)

**BLOCKED, and the operator has said it is not reachable with the current mover.** Two rooms
share the name "The Badlands"; **45** has the node, 615 does not.

## What happened, 2026-09-09

Routed from the cave side: `587 -> 586 -> 585 -> 584 -> 583 -> 593 -> 49 -> 45`. Two
characters (a 20-health caster and a 60-health fighter) reached **room 49, Kardde's Canyon**,
at full health — and then could not leave in any direction.

**Room 49 is now in `KNOWN_TRAPS`** (`098c509`). It takes characters in and does not let them
out, so the Badlands node is behind a trap and this approach is closed.

## The measurements, such as they are — and the lesson

Eleven refused departures: 6 to 45, 2 to 39, 3 back to 593 the way they came. Then seven rim
squares tried one at a time. **This is the anti-pattern the skill exists to stop** — eleven
proofs of the same refusal and not one fine-grid measurement. Recorded here so the next run
does not repeat it.

What is actually known:

- `badland2.roo`, reported **27 rows x 24 cols** from the world map `.roo`.
- **The router insists `49 -> 45` is a SINGLE DIRECT HOP.** So the room graph has the edge;
  this is not a pathfinding failure at that level.
- **The mover moves freely INSIDE the room.** East rim `r13c22` returned `arrived: true` in
  31 steps. Nothing is wedged.
- **No edge crossing from any square tried**: mid-rims `r1c12`, `r25c12`, `r13c1`, `r13c22`;
  extremes `r13c23`, `r12c23`, `r6c23`, `r20c23`, `r26c12`, `r0c12`, `r13c0`.
- Two informative predicate names: **south** gave `no_ground_gained` blocked at `r11c4`;
  **west** gave `refused_edges: 11` blocked at `r10c4`. Both stalled around **column 4**
  while aimed at opposite rims, which is the most suggestive fact on this page and has not
  been followed up.
- `look` reports `exits: []` and exactly one object in the room, so **no crowd** is holding a
  boundary.
- Blink cast successfully (mana 33 -> 19), moved the body to the room's place of power,
  changed nothing.

Entering worked and leaving does not: the signature of a bake holding an inbound edge with
no usable outbound one.

## What to do next, and it is not another walk

Nothing here was measured with the fine grid. Before any further movement:

1. `node tools/m59-roomview.mjs 49` and read it. Which squares does each predicate admit,
   and where is the boundary the flood stops at?
2. **Why do south and west both stall near column 4** from opposite directions? That is one
   region, not two failures.
3. Fine floors along the whole east rim — `arrived: true` at `r13c22` with no crossing at
   `c23` suggests the outbound edge wants a fine cell the walker will not stand on.
4. Then the **frontier report** and the **jump audit** from the skill's backlog. This node is
   the motivating case for both: `no route` and eleven identical refusals are exactly what
   those tools exist to replace.

Do not send a body back into 49 to look around — it cannot get out, and two characters had
to be recovered by hand.
