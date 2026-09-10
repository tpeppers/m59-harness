# victoria — NODE_VICTORIA, room 39, stone at r13c46

**The approach is SOLVED. The last twelve squares are not.** Marco Polo (hk2) crossed the
whole world to the stone's room at full health on 2026-09-10 and then could not walk the
last twelve squares, for a reason that is measured and is not the geometry.

## The road works, and Ukgoth is not the problem

`walk(39)` through fleetScript, one order, room 27 to room 39 in **under four minutes** at
20/20 health:

```
06:48:16 walking 27 -> 39, budget 421s
06:51:33 room 599 r2c27          <- Ukgoth, on the north door
06:51:48 room 2   r19c8
06:52:04 room 2   r5c44
06:52:12 step (walk) ok          <- room 39, r5c34
```

Every road to this stone crosses **599, Ukgoth**, which is in `KNOWN_TRAPS`, so the script
has to say so out loud: `unsafe: { reason, waives: ['trapCheck'] }`. Do that and the journey
is unremarkable.

**The trap entry and the falljumps file are answering different questions and both are
true.** `node tools/m59-exitreport.mjs 599` prints them side by side:

```
  WHERE YOU LAND COMING IN
    from 598  The Cragged Mountains -> r4c63
             from that square you can WALK to: south to 589, east to 598
             and you CANNOT walk to: north to 2
    from 589  Under the shadow of the Sentinel -> r67c3
             from that square you can WALK to: south to 589   <- and NOTHING else

  ONLY REACHABLE IF THE PLAN INCLUDES THE FALL
    landing r4c63 from 598: the north door to 2 at r1c27 is NOT walkable,
      but r1c66 -> r1c27 is baked with 1 fall: 3 cols west.
```

`reachableFrom` floods with `moverStepLands` one square at a time, so a three-column fall
can never appear in it and the north door reads unreachable. The bake's anchor route to that
same door carries the fall as a `(0,-3)` token and crosses fine — which is what the journey
actually used, and it worked first time. **A plan that treats the crossing as a walk searches
for ever; that is the failure the trap entry describes, and it is not a door that does not
exist.**

Two things that follow and matter more than they look:

- **Enter 599 from 598, never from 589.** From the southern landing at `r67c3` the only door
  you can reach is the one you came in by. The direction you arrive from decides whether the
  north road exists at all.
- **The failure is bounded.** Miss the jump and you are in the gutter at `r67c15` — 60
  squares, and its only way out is south to 589. A long walk, not a stranding.

## Room 39 is SPLIT and only one doorway is any use

Four doorways lead 38 -> 39 and they land you in two different halves that are not joined
inside the room:

| door in 38 | you land at | can you reach the stone? |
|---|---|---|
| `r2c19` / `r1c19` | `r8c28` | **yes** |
| `r2c17` / `r1c17` | `r8c23` | no — 22 squares off, and no fall bridges it |

The router picks `r2c19` on its own, which is the right one. If a future change makes it pick
the other, the symptom will be a character standing in the correct room, permanently 22
squares from a stone it can see.

## What actually stops the run: a step the PLANNER allows and the MOVER refuses

The stone is reachable from where the body stands. Measured, from his own square:

```bash
node tools/m59-exitreport.mjs 39 --at r6c34 --to r13c46 --box 2
#   r13c46 (or within 2 of it) is REACHABLE by walking from there
```

280 squares are reachable from `r4c34` and the stone is one of them; a directed BFS over
`moverStepLands` finds a **fifteen step** path. Given that path as one `walk_to`, the body
oscillated `r6c34 <-> r5c27 <-> r3c34` for its whole budget — twelve to nineteen squares out
— which is the two-square shuffle that resets every stillness timer it meets.

Walked one waypoint at a time, it names the exact square and the exact reason:

```
  STOPPED at r4c34, could not take the step to r4c35.
  within 2 squares of that waypoint: zombie at r3c33, battered skeleton at r6c35,
                                     battered skeleton at r4c37
```

One square east, refused three times. It was NOT the bodies.

## THE PREDICATE, NAMED — AND IT CONTRADICTS A DOCUMENTED INVARIANT

The live keeper's own `/movecheck` runs `validateFineTarget` for the four cardinals from
wherever the body stands. Standing at **r3c34**, against `moverStepLands` — the predicate
`docs/m59-routing.md` names as *the map the mover enforces*, and tells the router to plan on:

| step | live `validateFineTarget` | offline `moverStepLands` |
|---|---|---|
| **E -> r3c35** | **blocked, `geometry_blocked`** | **TRUE** |
| W -> r3c33 | moved, not blocked | true |
| N -> r2c34 | blocked, `geometry_blocked` | false — agrees |
| S -> r4c34 | moved, not blocked | true |

Three agree; east disagrees, and east is where the stone is. Walked south to **r6c34** and
asked again: **E -> r6c35 blocked, `geometry_blocked`** — while offline `moverStepLands`
answers `true` for `c34 -> c35` on every row from 2 to 9, and only turns false at row 10.
A direct fine trace offline, `traceFineMoveClient` from three different points inside c34
east into c35 at row 6, returns `arrived: true, blocked: false, slid: false` every time.

It is **not a stale map**: `roomSecurity` and `geoSecurity` are the same number
(`2327046116`) on both sides. It is **not the fine-grid-versus-square trap**: all 64 sampled
fine points inside r3c35 are walkable and `standable(3,35)` is true.

**So the invariant is false here.** The routing rules say plan on `moverStepLands` because it
is what the body obeys. In room 39 the body obeys a third thing — `validateFineTarget` inside
the keeper — and it refuses a step `moverStepLands` allows, along a whole column boundary.
That is a much bigger claim than "room 39 has a bad square", and it is the one these numbers
support: **the router believes in a road the mover will not walk**, which is why a 15-step
BFS path exists and the body shuffles instead of walking it.

**KNOWN LIMIT OF THE INSTRUMENT, and it is not carelessness.** `/movecheck` probes only the
FOUR CARDINALS from wherever the body is actually standing. Diagonals cannot be asked at all,
and an arbitrary step cannot be asked without first walking the body to it — which is the
same instrument problem the rest of this file is about, in a new place. The frontier report
the skill's backlog asks for is exactly the fix: flood to the boundary and print, per frontier
cell, the named predicate that refused it, without moving anybody.

## Working around it, and how far that got

The first theory was bodies — room 39 carries seven to eleven undead and monster collision is
height-agnostic — so a Dijkstra over `moverStepLands` that refuses any square within 1 of a
body and pays 6 per square to pass within 3 found a 24-step path along row 3 and down the east
wall, every square at least 3 clear. **It failed at the same step**, `r3c34 -> r3c35`, with
nothing on the destination square. That is what ruled the bodies out and sent the question to
`/movecheck`.

Worth keeping the technique anyway, and worth knowing its limit: a body-aware path computed
offline is stale before it is walked, because the undead move every few seconds. **Avoidance
has to happen in the mover, on the mover's clock, not in the plan.**

## The reachability table was wrong about this node's neighbours too

Measured 2026-09-10 with `--to <stone> --box 2`, from the square a body lands on coming in.
`--box 2` because the meld is `abs(drow) < 3 AND abs(dcol) < 3` per axis
(`mananode.kod:177`) — the stone's own square is frequently not standable *because the stone
is on it*.

| room | node | verdict |
|---|---|---|
| **39** | Victoria | **reachable** — east doorway only |
| **750** | Ice Caves | **reachable** — nearest square 1 off. Filed in the skill as needing new jumping mechanics; it needs none |
| 589 | Sentinel | only across the declared fall `r35c16 -> r38c19`, and only entered from 599. By walking, 9 off |
| 45 | Badlands | 3 off — one square outside the box |
| 27 | Icky Cave | 4 off, and the stone is on a one-way ledge. See [`cave.md`](cave.md) |
| 515 | Seafarer's Peak | 5 off |
| 1006 | Mausoleum | 10 off, and no route to the room from Tos |

## Traps this node taught

- **`approach` is dead on prod**: `s.world.approachSquare is not a function`.
  `m59-mananode.mjs` calls it inside `.catch(() => {})` and falls through to `walk_to`, so a
  broken verb and a working one look identical from the outside.
- **`act('walk_to', ...)` inside fleetScript times out at 60 seconds** — the broker's cap on
  its own RPC to the keeper, not the walk's budget. The keeper goes on walking; the step is
  scored a failure, the script unwinds, and the lease goes back with the character in open
  country. Use `walkTo(col, row)`, which issues once and reads the world back.
- **`rest({health})` refuses on a road leg** and that is the guarantee working. Mark it
  `optional: true`.

## THE WORKING PRIMITIVE IS `short_hop`, NOT `walk_to`. START THE NEXT ATTEMPT HERE.

The last run got further than anything else, and it did it by changing one call.

**`walk_to` PLANS, and its planner believes in this room's phantom ground.** Asked for the
square *next door*, it consults the coarse grid — which says `moverStepLands` is true for
c34→c35 on every row 2–9 and for c39→c40 on every row 1–17, while the live mover refuses
both — so it routes a one-square step as a forty-square loop back through the west of the
room. Measured: the crawl asked for one step EAST from `r13c40` and the body arrived at
`r4c27`, nineteen squares out. `connection_revision` stayed **1** the whole night, so nothing
logged it off and nothing teleported it. That was the planner walking it home.

That is what made the earlier rounds look like a teleport: `r11c42 -> r3c27`,
`r8c42 -> r8c29`, `r13c40 -> r4c27`. All three are the same thing.

**`short_hop` moves the body and does not plan** — at most ~1.6 squares, one step-height,
refused outright if it cannot be done. Swapped in, the crawl walked a clean line east along
row 9 straight through the boundary that had stopped everything else:

```
E -> r9c33 (13 out)   E -> r9c36 (10 out)
E -> r9c34 (12 out)   E -> r9c37  (9 out)
E -> r9c35 (11 out)   E -> r9c38  (8 out)
```

**ROW 9 CROSSES. Rows 3, 6, 10, 11 and 12 do not.** Every refusal is
`validateFineTarget: geometry_blocked`, and the offline model says all of them land. The wall
is a row-by-row thing and the bake cannot see any of it.

Where it ended: boxed at `c34` between rows 10 and 12 with all four cardinals
`geometry_blocked`, having dropped off row 9 on a diagonal and been unable to climb back.
Closest approach all night was **Chebyshev 4**, against a meld box of 2.

**The recipe to try next, in order.** Get into room 39 through the EAST doorway (`r2c19` in
38), then `short_hop` east **along row 9** — not row 3, 6, 11, 12 or 13 — to about c38, and
only then work south toward `r11c44`, which is the nearest square of the meld box. Never
issue a `walk_to` inside this room for anything closer than the far side; it will walk the
body home. And ask `/movecheck` before each step rather than trusting any plan: it is the only
thing in the stack that has been right about this room, and it distinguishes `object_blocked`
(a body — wait a few seconds, it moves) from `geometry_blocked` (this row does not cross).

**The tooling gap this leaves, and it is the frontier report again.** Nothing can enumerate
which rows of a boundary the live mover will cross without walking a body to each one and
asking. `/movecheck` answers four cardinals from wherever the body happens to stand;
diagonals cannot be asked at all and were probed blind. A report that floods to the boundary
and prints the refusing predicate per frontier cell would have produced the "row 9 crosses,
rows 3/6/10/11/12 do not" table in one command instead of an hour of walking.
