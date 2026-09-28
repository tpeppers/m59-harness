# badlands — NODE_BADLANDS, room 45, stone at r63c46

## Five-node tour connection

Partial tour `five-node-1790622360454` entered room 49 normally from 593:
r1c22, client x22016/y512, floor 6144. A fresh body-seeded cut reached
r27c20/x19536/y26704/floor 6016; the ordinary south crossing entered 45 at
r1c53/x53760/y512/floor 1664. The strict rail repeated the known node endpoint
x46080/y64448/floor 4096 and received already bonded, health 20/20.

Its return uses the measured full `floodReport` (64-unit lattice, cap 1,500,000)
into the exact r1c53 square, not `cutRail`'s smaller default cap. It reached
x54208/y960/floor 1664, crossed into 49 at r27c20/x19968/y27136/floor 6016,
then cut toward client x20544/y512 on the north shelf. See
[the tour report](../../../../docs/reproductions/five-node-tour-2026-09-28.md)
for the full-loop result and limitations. This partial replay is not a circuit.

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

### Live result and guard repair

First trial `badlands-1790613972596` reached floor 6144 in Kardde's Canyon,
then fell at aim 83: from client (12032,20992)/5632 toward
(12768,21728)/6016, actual endpoint (12272,21328)/3840. No monster was present.
64/128/256-unit traces of this diagonal are retained as `canyon-wp83-*.json`;
changing the sampling phase changes which thin floor it sees.

The shared shelf guard checked the float trace while `validateFineTarget`
subsequently quantized and re-traced an integer wire endpoint. Commit **0fd8d5a**
uses that sender validation for the guard. Its new collision regression sends
zero unsafe packets; before the fix it sent one and detected the fall afterward.
405 collision checks and 15 walking dependency checks pass.

The fixed replay `badlands-1790614493355` rejected four unsafe headings at aim
83, stayed on 6016, finished all 98 canyon aims, crossed normally into room 45,
then finished all 361 strict Badlands aims. Actual node arrival was r63c46,
client (46080,64448), floor 4096. The distinct meld message and stable
same-keeper **49 → 57** max mana verify one first-time grant. Health stayed 20/20.
The fixed approach passed **3/3 independent quiet-scene trials**:
`badlands-1790614493355`, `badlands-1790615094139`, and
`badlands-1790615724125`. The third followed a broker/keeper restart
(PID 41624 → 28088), still on 0fd8d5a. All started at the same documented
room-49 fine point and ended at exactly (46080,64448)/4096 with 20/20 health.
One first grant and two already-bonded replies establish repeatable arrival and
interaction, not three first grants. The pre-fix failed trial remains in the ledger.
The operator was notified immediately at this threshold.

Return-only experiment: `node-escape` stages before its measured route, activates
no node, and writes `escapes.jsonl` separately. It cuts a checked return from the
node shelf to room 45's north exit, then through 49 to 593. Use a northern canyon
goal at client (20544,512), not (20544,64): the latter lies against the boundary
and the strict in-room flood does not reach it. Actual edge crossing is a separate
normal movement command. A return cut needs more than the default 400,000-point
search budget in room 45; do not label that cap as terrain impossibility.

Return trial `badlands-escape-1790616387096` passed 45 → 49 → 593 from the
exact approach endpoint, ending r29c36/(36352,29184)/2560 with 20/20 health.
This is **one** walking-return pass, not three. Both edge commands pessimistically
reported an out-of-grid refusal; subsequent actual room reads proved the crossings.
The first escape setup failed before movement because `look.you.id` was absent.
The retained recipe uses the successfully exercised square-placement plus bounded
fine-alignment setup, then begins the measured return. Remaining experiment:
reintroduce one captured obstructing body at canyon aim 83 and repeat the approach
with floor receipts; quiet-scene success does not establish monster tolerance.

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
