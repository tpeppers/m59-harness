# badlands — NODE_BADLANDS, room 45, stone at r63c46

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
