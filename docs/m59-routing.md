# Movement, collision and routing

Split out of [`CLAUDE.md`](../CLAUDE.md). Read this before touching `m59-movement.mjs`, `m59-routes.mjs`, `m59-roo.mjs`, `m59-routebake.mjs` or the mover inside `m59-broker.mjs`.

**Coordinate legend:** MCP tools use named `col`/`row` fields; positional
movement helpers use `(col,row)`; `RoomGeometry`, KOD grids, and route-grid
calculations use `(row,col)`; fine `{x,y}` means X→column and Y→row; movement
bytes are serialized Y then X. Human-facing locations below use `rNcM`. Quoted
logs and commands retain their legacy positional spelling. Read
[`m59-coordinates.md`](m59-coordinates.md) before comparing or changing a
coordinate boundary.

## The collision map is EVIDENCE ABOUT A SERVER, NEVER AUTHORITY OVER ONE

`substrate/m59-map.json` carries baked BSP, sidedefs, sector heights and wall chains, and
the broker validates every in-room move against them with the same rules the stock client
uses — because the server accepts whatever coordinates you send and expects the CLIENT to
enforce collision. Using the server as a collision oracle is how bots walked through walls.

**A move that cannot be validated is refused, not retried.** `TERMINAL_MOVEMENT_REASONS`
in `m59-movement.mjs` is the closed list of failures that no other heading can fix —
`collision_geometry_unavailable`, `room_geometry_mismatch`, `room_security_unknown` and the
rest. They propagate instead of looping, which is what stops a bad route being learned.

### THE ROUTER HAS TO PLAN ON THE MAP THE MOVER ENFORCES, AND THE TWO ARE NOT THE SAME MAP

The mover validates against the client's BSP; the router planned on the server's coarse
one-byte-a-square grid. A router planning on a different map from the one the mover
enforces does not produce a wrong route — **it produces a character sliding along a wall,
replanning into the same wall, and giving up.** The legacy `row,col` trail strings read
`4,15->5,15=5,15` / `5,15->4,16=4,15`, over and over, eight times, then "kept ending up
somewhere other than the planned square". Measured offline against the twelve boundaries
`m59-exitgap.mjs` complains about most, **that killed 59% of all walks to an exit**; on
prod it killed characters, who bounced between two squares in the Western border of the
Twisted Wood with spiders on them.

**THE PREDICATE THAT LOOKS RIGHT AND IS NOT.** `stepAllowedByCollision` asks whether the
straight line between two square CENTRES arrives exactly, with no sliding. That is a fair
question about a line and the wrong one about a character: the player is a disc of radius
248 in a square of 1024, so a centre within a quarter-square of a wall is a place nobody
stands, and a person walking that corridor never tries to. Asked that way, room 150 comes
out in 159 disconnected pieces and room 578 in 214 — which is why collision-aware routing
was measured, disbelieved and switched off.

**`moverStepLands` is the question that decides anything**: what `validateFineTarget` will
actually do — aim at the centre, SLIDE, quantize toward the start, and land IN the target
square, because `walkTo` compares squares. Same rooms: 150 in 15 pieces with 96% in one,
578 in **two** with 99.4% in one. `protocolToward` is exported from `m59-roo.mjs` so the
planning half and the sending half cannot drift; the test compares them directly.

Three things hold this up and each fails in the dangerous direction if inverted:

- **The mask is what makes it affordable, and it is baked offline.** `buildStepMask` is one
  byte a square, one bit a direction, in `STEP_MASK_DIRS` order — which may never be
  reordered, because a mask read against a different order is a confident map of the wrong
  doors and nothing downstream can detect it. `node tools/m59-routebake.mjs` writes it,
  `attachStepMasks` in `m59-routes.mjs` hands it to the geometry at broker start, and
  `path()` then defaults to `collision: this.hasStepMask`. **No table means the coarse grid,
  exactly as before** — a checkout that has never run the bake behaves precisely as it did.
  Running the trace live is what caused the rejoin storm: 0.44ms a pair, tens of thousands
  of pairs, on the one event loop twenty-one sessions share.
- **`walkTo` learns the EDGES it is refused, not the squares.** A wall sits between two
  squares; blaming the square removes a good place to stand that other neighbours reach,
  and a step that SLID recorded nothing at all, which is what made the bounce eternal. The
  edge is attributed from where the step was ASKED, never from where it landed — a slid
  step ends at neither end of the step it requested, and blaming the landing square blames
  an edge nobody tried. `object_blocked` is treated as the opposite fact: **a monster moves
  and a wall does not**, so only the first is worth waiting 700ms for.
- **A body is not a wall, and fanning around one is not a walk.** `walkFine` fans nine
  headings and slides, which finds the gap in a wall the straight line missed — and against
  a BODY shuffles two squares for the whole step budget, because each slid step counts as a
  few units of "progress". Castle Victoria, 2026-08-26: six fleet characters converged on
  one corner (two on the same square), every direct heading refused by a fleetmate, all
  "travelling — NOT MOVING" for a quarter of an hour with `require_safe_wall` on. Two
  rules, both pinned by `m59-collision-test` and `m59-takesafespot-test`: `walkFine` hands
  a body back as `object_blocked` after three fans without half a square of net progress
  (real progress around it resets the count), and the safe-spot selector skips squares
  another PLAYER stands on or next to for a non-combat shelter pass. Target-first pull
  selection uses the literal occupied square (plus any body marked `MOVEON.NO`) so an
  unoccupied closest wall is not discarded merely because somebody stands beside it.
  An atomic cross-process claim closes the choose-before-arrival race.
- **THE SAFE WALLS ARE THE RED SQUARES IN THE DEBUG CLIENT, AND THE KEEPER CHOOSES FROM
  EXACTLY THAT SET.** Corrected 2026-08-27 by the operator, who checked the minimap room by
  room. One function, `safeWalls()` in `m59-safespots.mjs`, is both the picture
  (`m59-overlay.mjs`, layer `F`) and the keeper's candidate list (`safeSpots()` iterates it
  and nothing narrows it). A red square is a coarse-walkable square from which **no square
  within monster reach has coarse line of sight** (`exposureAt().attackers === 0` —
  `Room.LineOfSight`, transcribed) **while at least one square within our own reach can be
  hit without answering** (`free_shots > 0`). That is the two grids disagreeing about the
  same square — the monster's grid says "cannot reach", ours says "can hit". Escape room,
  exposure, ledges and the room's outer ring are all still measured and they RANK the
  list; none of them removes a wall the picture shows. Two earlier definitions were wrong
  in opposite directions and both are gone: open floor graded by enclosure (pre-08-23), and
  only squares the coarse grid REFUSES (08-23 to 08-27) — the latter was disjoint from the
  picture by construction, so the fleet stood beside hundreds of verified walls and was
  told it had none. `m59-safespot-test` pins the identity; `node tools/m59-overlay.mjs
  --all` regenerates the picture.
- **A wall square is entered along the fine path, never along the line.** The straight
  line into a wall square from open floor is often exactly the step the geometry declines,
  and `walkFine`'s fan slides along the face for the whole budget: "could not walk back to
  the square — ran out of steps", one square out.
- **PULL COMBAT CHOOSES THE QUARRY FIRST, THEN ITS WALL.** Among canonical safe walls the
  closest Euclidean square to that exact object id wins, after three hard eligibility
  checks: the player can route to it, no other body/person occupies or has reserved it, and
  a flood from the quarry on the stock server's **coarse monster grid** reaches some square
  inside the player's radius-2 combat disc around it. A target/wall pair stays fixed across
  bounded walk legs; a true no-progress destination failure is excluded briefly rather
  than driven into again.
- **A TAGGED QUARRY HAS TO KEEP CLOSING.** Its exact live id and distance to the chosen wall
  are sampled every three seconds. A closer sample resets the counter; three consecutive
  non-closing samples cool that target and select a different quarry and that quarry's own
  closest valid wall. Lost aggro is target evidence, so this transition never writes the
  wall to `barrenSpots` or condemns the room.
- **A pull that cannot REACH the prey means the wall is too far, not that the wall is bad.**
  `pullAttemptFailed` (a failed *reach* — "the coarse grid found no route beside the target")
  used to add the square to `barrenSpots` and, three walls later via `noWallRooms`, abandon
  wall-fighting for the whole room. It now never blacklists and never abandons: it returns
  `relocate` and the keeper takes a wall biased hard toward the quarry (`nearQuarry` →
  `fromFightWeight` 3, so distance-to-prey beats distance-to-us) and pulls from there.
  Piggy and Lew, Valley of Ileria 2026-08-27: prey 26–44 cells off, every wall they took was
  too far, and the old path walked them in circles retiring good walls. This is a different
  failure from `pullDidNotConvert` (reached, hit, nothing followed — a cliff square), which
  still retires. `m59-safespot-test` pins both. `approachFine` now asks the geometry's own `finePathProtocol` (step 8 — the
  A* that `/findpath` and combat use) and follows its waypoints first, falling back to the
  line only when there is no path. **Not `finePath`**, `walkTo`'s 256-unit lattice detour:
  measured on the same three walls, the lattice answered "no fine route" for all three
  while `finePathProtocol` found each in five to seven waypoints — a wall square is
  standable only in a sliver, and a coarse lattice cannot land on a sliver. Do not read the broker `safe_spots` tool's default `limit: 8` as
  the room's supply of walls — it is a display cap.
- **The mask may only ever PREFER.** It is a model of somebody else's server and it is
  stricter than the world — on room 579's north boundary it offers no reachable staging
  square at all from 19 of 35 starting squares. So `exits()` floods twice and falls back to
  the coarse answer, flagged `grid_only`, rather than dropping the exit; `walkTo` relaxes
  occupancy first, then refused edges, then the collision view. **A bake must never be the
  reason a doorway disappears.** Being wrong about a wall costs a walk; refusing costs the
  errand, silently.

**AN ANCHOR BELONGS TO A DESTINATION, NOT TO A DIRECTION — AND GETTING THAT WRONG DOES NOT
FAIL, IT ARRIVES SOMEWHERE ELSE.** One wall can carry two exits to two different rooms,
split by a row or column condition. Western border of the Twisted Wood declares
`east -> 586 row<19` **and** `east -> 597 row>20`: the same boundary, and which room you
reach depends on where along it you step off. `exitAnchors` asked
`edgeApproachCandidates(dir)` — the per-DIRECTION question — took the first square offered
and gave **both** exits the anchor `r9c67`, which satisfies `row<19`. So a character asked
to walk to The Twisted Wood was routed to a square that puts it in Main gate to the city of
Tos. Every leg reported success. Nothing downstream compares where a walk MEANT to go with
where it went, so this is invisible from the trail, from the board and from the logs — it
shows up only as a character that is somehow in the wrong town, and then as a journey that
re-routes from there for ever.

The per-exit question already existed and the bake was reaching past it. `edgeCandidatesOf(room, e)`
runs `selectedEdgeAt`, which simulates `StandardLeaveDir`'s own ordered scan of
`plEdge_Exits` — and that scan is why testing the one condition in isolation is not enough:
a default entry is remembered but does **not** stop the scan, so a square can satisfy a
condition and still lose to a later unconditional edge. The world model had always used it.

Two things pin it, and the second is the one that is not derived from the same `.roo` the
anchors came from. `m59-routing-test.mjs` asserts that crossing AT an anchor fires the exit
it was baked FOR — **273 on-boundary anchors, and the assertion is about the destination
rather than about arriving**, because arriving was never the symptom. And
`substrate/m59-crossings.json` records where a real client actually crossed and what room it
turned up in: **25 recorded crossings, 25 agreements, 0 disagreements**. Ranking in
`exits()` is observation first, baked anchor second, derivation last, for that reason.

**AND THE BAKE IS NOT ABOUT PLANNING COST — MEASURE BEFORE BUILDING A TABLE TO AVOID ONE.**
The natural reading of "why should getting from one exit to another take any real-time
planning" is that planning is expensive. It is not: measured on this map with masks
attached, `path()` costs **0.28 ms in room 587, 0.46 ms in 545 and 1.06 ms in The King's
Way** — and that was while a full bake was saturating the CPU. A flow field per anchor
would have bought about a millisecond a room for several megabytes. What the table is
actually worth is **correctness** (the anchor above), **proof** (which exits the room's body
can genuinely reach, which `steps` only guesses at) and **a cost that can be compared** —
`transitCost` prices a room crossing in PIVOTS rather than squares, because a client reports
position about once a second, so pivots are packets are seconds. The same six routes in 587
are 311 squares and 66 pivots: charging squares overstates a trip 4.7x and does it
*unevenly*, so ranking routes on square count prefers exactly the rooms that walk slowest.

**A SAFE SPOT IS THE LAST THING WORTH ROUTING THROUGH, AND A* DOES NOT KNOW THAT.** With a
flat step cost the router is indifferent between the middle of a gap and the tight side of
it, so it threads characters along the wall — where a step SLIDES, the mover lands somewhere
the plan did not expect, and the walker starts the bounce above. `clearanceField` adds cost
by how much of a square's step ring the MOVER refuses, measured off the baked mask because
the coarse grid calls the tight side of a gap open and agreeing with it here is how the plan
and the walk come apart. Measured on this bake: mean blocked neighbours per step across
random routes goes **1.35 -> 0.72 in room 587**, 1.28 -> 0.49 in 597 and 0.23 -> 0.05 in 544,
for 6-8% more steps.

**AND IT IS OFF UNLESS THE CALLER ASKS, BECAUSE A SAFE WALL IS A TIGHT SQUARE BY
DEFINITION.** This is the one setting in the router that can quietly teach the fleet out of
the game's central defensive mechanic, and it did: `world.reach` measures how far a wall is
and `nearestSafeSpot` ranks candidates at **-0.5 a step**, so with the preference on
everywhere it became a penalty ON THE SPOT ITSELF. Measured against the recorded book,
**36.7% of walks to a held safe wall came back longer, worst case +9 steps — 4.5 points
against a proof bonus of 20** — and it fell hardest on the walls that are hardest to walk
into, which are the best ones. So `path` and `clearanceField` both default to weight zero,
`leaveVia` opts in at 0.6 because crossing a room to a boundary is the long routing where
the wedge happens, and every tactical question — `world.reach`, `approachSquare`, a pull, a
melee approach, a walk back to a held wall — plans exactly as it did before any of this
existed. Three further properties: it is **cost, never a prohibition**, so a route that only
exists through a tight gap is still taken; **the destination is exempt**, because walking to
a wall corner is the whole point; and **no mask means no field at all**.

**AND THE BAKE'S "REGIONS" ARE THE SAFE SPOTS.** They are strongly connected components
now, not a flood fill, and a room coming out in ninety pieces is one body of floor plus a
scatter of corners the BSP hems in — the same geometric fact the safe-spot book measures
from the other side. Do not smooth them away to make the count look tidy. What the old
flood could not say, and this can, is the difference between a pocket you can leave but not
enter and one you can enter but not leave; for routing one is a trap and the other a
detour, and for a safe spot only the second is worth walking to. **"Outside the main body"
is not "cannot be walked to"** — a doorway is a pocket by design, which is why an exit
anchor is chosen from a staging square the body can REACH rather than the first one the
boundary publishes, and why the report says "go and look before believing it".

**THE CRAGGED MOUNTAINS CLIFF, STATED AS THE MECHANIC RATHER THAN AS A DIRECTION.** Enter
578 from The King's Way and you are at the BOTTOM: the other exits cannot be walked to at
all. Casting **blink** inside the room puts you on TOP of the cliff, and from up there every
exit is freely reachable. So the one-way is **north to south**, and it is one-way only for a
character that cannot blink — which is what "joined only by blink" always meant.

Walked by the operator 2026-08-17, in both directions: from the southern exits you CAN walk
north; from the north exit you cannot walk south.

**CORRECTION, same day, to a correction: an earlier version of this paragraph said the blink
note was wrong. It was not** — blink up the cliff is exactly the mechanic. What was wrong
was the claim that this is **"the one place in the world"**: the operator also names Ukgoth,
Under the shadow of the Sentinel, the Cragged Mountains/Ukgoth border and the Underworld.

**AND IT IS A CAPABILITY, NOT ONLY A GEOMETRY.** A route through this room from the north
is passable for a character holding blink and impassable for one that is not, so "can this
fleet walk King's Way -> Cragged -> An ancient place" is a question about the CHARACTER.
Nothing in the router asks that today.

**WHY THE MODEL LETS A BOT CLIMB IT: `MAX_STEP_HEIGHT` HAS EXACTLY ONE ENFORCEMENT SITE AND
IT IS INSIDE THE WALL TEST.** `canCrossWallAt` returns TRUE immediately for a null sidedef,
and at this face there is no sidedef — the wall there begins at z 4800, the TOP of the drop,
and runs up to the ceiling, so nothing at all spans the 1600 units between the 3200 floor
and the 4800 one. It is a bare discontinuity between two sectors. No wall is crossed, so no
height is ever checked, and `moverStepLands` says yes to a 1600-unit climb against a limit
of 384.

`traceFineMoveClient` takes `enforceStepHeight`, **off by default**, which adds the missing
check per microstep. Switched on it gets 578 exactly right — north exit reaches nothing,
southern exits still walk to it, 13 regions. It is off because it also refuses SLOPES, which
are continuous legal climbs: 3 controls in `m59-collision-test` and 1 in
`m59-impossible-test` break, all of them legitimate moves, and 578's routing view fragments
to 146 pieces. Narrowing it to a sector CHANGE is the right idea and does not fire, because
the microstep resolver reports no transition at that face. **The consequence of leaving it
off is known and bounded**: the router offers a walking route out of the basin that only a
character with blink can take.

Measured, so a fix can be judged: across 235,701 legal steps in ten rooms, 98.34% rise no
more than `MAX_STEP_HEIGHT` in any microstep, 1.66% would be refused, and almost all of
those are in 578. And the Underworld — which climbs hundreds of units and is entirely
legitimate — profiles as many small steps (2176 -> 2560, 3360 -> 3680), while the Cragged
Mountains face profiles flat at 3200 for seven eighths of a step and then 1600 in one. That
contrast is the signal any real fix has to key on.

**ONE-WAY COMES IN TWO KINDS AND ONLY ONE OF THEM HAS A HOME.** A link between two ROOMS
is recorded in `substrate/m59-oneway.json` and honoured by `passableExits` in
`m59-map.mjs`. A one-way *inside* a room cannot be expressed there at all, and room 578 is
that second kind: `path()` plans straight down the cliff, 48 steps from the north exit to
the southern ones, on a route that contains a **+1600 climb and four 1600-unit drops
against a `MAX_STEP_HEIGHT` of 384**. Terraces, walked like stairs. That is a live routing
bug — a character sent that way gets a confident plan it cannot execute — and it predates
the standable/stand-point work, which only made the same wrong route shorter.

**THE TABLE IS COMMITTED, AND THE ARGUMENT FOR THAT IS THE MANIFEST.** It used to be
gitignored on the grounds that it is "regenerated in seconds, so it is build output" and
that "a committed copy is actively misleading the moment the map is rebaked". The first
half is simply false — it is **about thirteen minutes** on this machine — and the second
half is backwards: the table carries `geometryManifestSha256` and is **refused outright**
when it does not match, so a stale committed copy is inert and says so
(`[routes] planning on the coarse grid — the routing table was baked from different
geometry`). What is genuinely misleading is its ABSENCE, which is silent and puts a fresh
clone straight back into walking into walls. `substrate/m59-map.json` (27 MB), `m59-spawns.json`
and `m59-items.json` are all committed derived data already; this is 1.4 MB of the same kind,
and it is regenerated in the same breath as the map it comes from.

```bash
node tools/setup.mjs routes        # bake it; `all` runs this, before the broker
node tools/setup.mjs doctor        # says whether the table on disk carries masks
node tools/m59-routebake.mjs --resume    # after a killed bake: keeps what is on disk
node tools/m59-routes.mjs                # what is baked, and whether it matches the map
node tools/m59-routes.mjs --verify       # re-walk every baked route
```

**A STALE TABLE IS NOT ALWAYS A STALE MAP, AND THE MANIFEST CANNOT TELL YOU.** It hashes the
GEOMETRY. When the anchor-SELECTION code changes, a table baked by the older code passes
every check here and is confidently wrong about where a doorway is. That is not
hypothetical: Ukgoth's north anchor to Outside Castle Victoria was baked at row 1, col 62 —
five grid-walkable squares with no coarse-grid connection to the room's other 1,679 — while
the current code answers `r2c26`, the operator's real doorway. Rebake after touching
`exitAnchors`, `edgeCandidatesOf` or `neighbors`; nothing will remind you.

Three more offline tools, and each answers a question the others cannot:

```bash
node tools/m59-walksim.mjs --cycle       # will the WALKER get stuck — the mover, not the router
node tools/m59-clipsweep.mjs --anchors   # doorways only a clip can reach
node tools/m59-falljump.mjs              # the jumps somebody walked and wrote down
```

`m59-walktrial.mjs --plan-only` asks whether a ROUTE EXISTS and is essentially perfect from
ordinary squares — it said so for months while the fleet stood in corners.
**`m59-walksim.mjs` asks whether the WALKER ARRIVES**, by driving the real `path`,
`standPoint` and `traceFineMoveClient` with the fine position carried forward, and that is
where the failures are: the router validates centre-to-centre, the mover slides, and after
the first slide the body is never on a centre again. It reproduces the two-square bounce
offline, on demand, with no server:

```bash
node tools/m59-walksim.mjs --room 598 --from 19,8 --to 64,19 --trace
```

That command's existing `--from`/`--to` grammar is `row,col` (`r19c8` to
`r64c19`). The command is intentionally not rewritten to accept `rNcM`.

`m59-clipsweep.mjs` counts where the collision view is more permissive than the coarse grid
— the invariant running backwards, 30,878 steps and, before the bake learned to prefer a
coarse-connected staging square, 116 rooms of 264 with an exit anchor only a clip can reach
(96 after). `CLIP_STEP_COST` in `m59-roo.mjs` prices those steps rather than forbidding
them, because 137 of 2,164 recorded human positions are squares the coarse grid calls wall.

Three things about running it that are not obvious. **`--resume` adopts only what was baked
from the same geometry AND the same view** — a half-table stitched from two maps is the one
kind of wrong nothing downstream could detect. **The partial table is flushed every minute
and carries `complete: false`**, because the whole thing used to be a single write after the
loop and a Ctrl-C at room 250 of 264 produced nothing at all. And **`doctor` counts MASKS,
not rooms**: a table baked before masks existed has all 264 rooms, matches the manifest, and
leaves the broker on the coarse grid — counting rooms put a green tick over exactly the
failure that line exists to catch.

**AND `--verify` WAS ASKING THE WRONG MAP, WHICH IS THIS FILE'S OWN CENTRAL MISTAKE
COMMITTED BY THE TOOL THAT EXISTS TO CATCH IT.** The table is baked `view: collision` — the
mover's fine BSP view — and `--verify` re-walked every step against `walkable()`, the coarse
one-byte grid. Those two disagree *by design*: the disagreement IS what a safe wall is, and
there are 17,402 such squares. So it reported healthy routes as broken wherever the views
differ, which is precisely where the interesting geometry lives.

Measured on the table in play: **1358 of 16293 routes "invalid" by the coarse predicate and
ZERO by `moverStepLands`.** Every one of the 1358 was a false alarm, and they were not
harmless — they read as "we have baked routes that walk through solid rock", which is the
opposite of what the table says, and sent a live investigation into rewriting a bake that
was correct. **A verifier that checks the wrong predicate does not merely fail to find bugs;
it manufactures them.** `--coarse` still asks the old question, and the output now names
which predicate it used and the table's view.

**AND THE ANCHOR IS THE OTHER HALF: ONE SQUARE PER EXIT, AIMED AT BY EVERY WALK, NEVER
CHECKED AGAINST THE SERVER.** `exitAnchors` bakes one staging square per exit and
`m59-world.mjs` ranks it first, so a room's whole traffic converges on it. Our geometry has
an opinion about whether it is standable; only the server's counts.

```bash
node tools/m59-anchorprobe.mjs --who <character>      # every anchor, placed and read back
node tools/m59-anchorprobe.mjs --report               # the last run, no server needed
```

**THE MEASUREMENT IS THE DISPLACEMENT, NOT THE RETURN VALUE.** `UtilGoNearSquare` never says
no — handed a square it will not stand you on it searches OUTWARD, puts you somewhere else
and returns 1 — so the only evidence is reading `piRow`/`piCol` back afterwards and
comparing. `m59-dm.mjs relocate --verify` does **not** do this: it checks only that the
character is in the right ROOM and then reports the square it ASKED for, which reads as a
confirmed placement and is not one.

First full sweep, 2026-08-20: **1341 anchors, 1313 exact, 5 displaced by at most 6 squares
(rooms 853 and 702), 23 landing in another room** — the last are `go` anchors on portal
squares, where being moved is the point. So the monorail terminals are sound, and an anchor
is not where to look when a fleet stalls.

**Issue #44 is the asymmetric coordinate test.** Room 563 is 34 rows by 76
columns. Protocol fine `{x:3936,y:1952}` decodes to `col=61,row=30`, or
`r30c61`, and that square genuinely has no floor. The diagnostic
`[exit] injected 34,65` and the travel-ledger square `"34,65"` are legacy
`row,col`, however: both mean the valid south anchor `r34c65`, whose 64-unit
fine centre is `{x:4192,y:2208}`. The east anchor `r27c76` centres at
`{x:4896,y:1760}`. Comparing the unlabeled strings made floorless `r30c61`
look like evidence against valid `r34c65`; labeling the coordinate spaces shows
that no floor or anchor calculation contradicts the other. See
[`m59-coordinates.md`](m59-coordinates.md).

`node tools/m59-routing-test.mjs` (38) pins all of it, offline.

## Six-city routing matrix and wire proof

`m59-city-matrix.mjs` is a **wire proof for the six-inn fixture**, not the six-city
zero-death instrument. Six disposable characters at 10,000 health are placed by DM on a
staging square inside each city's inn and sent along the 25 walkable directed pairs between
those squares with `run_errands: false`; what a PASS proves is that every coordinate packet
the mover sent validates against the BSP, that the exit fallback was never enabled, and that
the capture is one complete ordered sequence `m59-collision-trace-verify.mjs` can replay.
It cannot observe deaths, damage, rests, wall detours or the time a real crossing takes — a
fixture at that health cannot die and a DM placement skips the approach — so whether a real
character can cross Meridian and live is `m59-solo-run.mjs` (one at a time, real health,
`--tour` for a circuit) and `m59-hoptest.mjs` (every doorway independently). It has **DM
authority** and is for a disposable loopback server only; it holds the fleet run lock
(`m59-runlock.mjs`) for the whole run. Start the broker through `m59-service.mjs`; do not
launch `m59-broker.mjs` directly. A proof run must use `--in-process`,
`M59_COLLISION_TRACE=1`, `M59_EXIT_FALLBACK=0`, and the default collision trace path (leave
`M59_COLLISION_TRACE_FILE` unset). The ordinary per-character keeper-process driver — the one
every real fleet runs — has six independent sequence counters and therefore cannot produce
one ordered fleet trace, and the runner refuses it from `/health.session_driver`.

A proof is one fresh capture. Stop the old broker before clearing the trace; deleting a
live process's file does not reset its in-memory sequence counter. Then clear and start the
disposable fleet through the supervisor, with the environment above set for the `start`:

```bash
node tools/m59-service.mjs stop --fleet routing-lab --http 8911 --dashboard 8912 --no-ui
node tools/m59-collision-trace.mjs --clear
node tools/m59-service.mjs start --in-process --fleet routing-lab --http 8911 --dashboard 8912 --no-ui
```

The runner refuses a fresh run if the trace already exists. It also independently refuses
to begin unless `/health` proves the exact checkout, named fleet roster, single in-process
driver, enabled default-path trace, six live agent-to-character and object-ID mappings,
common local game endpoint, empty geometry drift, and the effective disabled fallback.
Before any DM mutation—and again before every batch—it resolves all six names through the
admin socket and requires those live object IDs to match the broker sessions.

Generate the credential-free config shape, save the real participant mapping only under
the ignored `substrate/traces/` directory, and run either sweep:

```bash
node tools/m59-city-matrix.mjs --example
node tools/m59-city-matrix.mjs --config substrate/traces/city-matrix-config.json
node tools/m59-city-matrix.mjs --config substrate/traces/city-matrix-config.json --mode serial
```

Parallel mode runs the exact 25 physically walkable directed pairs in five batches, one
leg per pair. Serial mode preserves the stronger experiment: all six participants traverse
all 25 pairs, for 150 legs. Ko'catan's five physically impossible outbound directions are
recorded as expected exclusions, not failed routes. Every checkpoint is an atomic private
file; `--resume` accepts only a clean contiguous prefix made with the same config and
schedule and its existing trace. Every participant's exact staging square is rechecked
after all sequential relocations and immediately before movement begins. Reports name
characters and positions, so they stay under `substrate/traces/` and are never committed.

The wire verifier is offline and opens no socket:

```bash
node tools/m59-collision-trace-verify.mjs
```

It combines the default collision capture, matrix report, and exact movement map; replays
every sent coordinate against the BSP; proves off-map packets against declared exits; and
scores every matrix interval. A proof-bearing capture must begin at sequence 1 and account
for every row. Room continuity uses stable room numbers plus live/baked map security, never
transient room object IDs. Exit fallback must be proved false by recorded broker health (or
explicitly on every wire row); the old `--fallback-disabled` promise is deliberately
rejected. Deliberately raw keeper/exit fallback sends are recorded as unsafe rather than
silently omitted, which makes the verdict fail. Captures and verdicts are ignored private
artifacts.

**AND THE SAME FACT THAT MAKES A SQUARE SAFE MAKES IT A TRAP: THE WAY OUT OF A POCKET IS
THE WAY IN, WALKED BACKWARDS.** A safe wall IS the coarse grid and the BSP disagreeing —
that is the mechanism, measured — and the fleet seeks those squares out. Since the router
plans on the collision view, a character standing on one frequently **cannot plan a route
to its own room's exits**: room 587 is 68 regions with both exits in region 0, and there
are 17,402 such pockets world-wide. It tries, is refused, replans, tries again, forever;
the keeper pass never returns, so the board reports `travelling` while the character
twitches in a corner. Watched in the client 2026-08-16 — *"like a person pretending to get
stuck trying to find their way out the door right next to it"*.

`queueValidatedMove` therefore keeps the last 64 moves it sent, and `retreatAlongBreadcrumbs`
replays them in reverse when `walkTo` finds no route. **Every step replayed was accepted by
the fine validator on the way in, so it cannot invent an impossible traversal — it can only
undo one.** That is the whole argument for breadcrumbs over the obvious alternative: a
coarse-grid escape hatch was **considered and rejected**, because falling back to the
server's grid relaxes collision precisely where the two views disagree most, which is the
mechanism that let bots climb cliffs and cross boundaries no client can. The concern was
never that a bot slips slightly too deep into a safe spot.

Four things it does that read backwards:

- **A broken trail is dropped whole, never skipped.** A crumb that does not START where the
  character is standing means something else moved it — a teleport, a knockback, a room
  change — and the crumbs below it are no better connected than that one.
- **It stops the moment the route reappears.** The goal is to leave the pocket, not to undo
  the journey, so `until` is asked after every crumb.
- **A refused reverse step ends the retreat and says so.** It is the same validator, so a
  step it will not authorise is not forced; the walk then fails honestly, carrying
  `retreated`, rather than silently.
- **It runs once per walk.** Undoing the trail twice unwinds the journey.

`node tools/m59-breadcrumb-test.mjs` (32) pins all of it against a scripted validator —
including the one-way ledge, which is the case that must stop rather than teleport.

**THE BAKE IS LOCAL AND THE SERVER IS NOT.** The map is generated from a source tree here;
`prod` is somebody else's machine and can be patched on a Tuesday without telling us. Two
consequences the design turns on:

- **A stale map is a WARNING at startup, not a refusal.** It used to `return 1` — no
  broker at all. But the per-move validator already fails closed one room at a time,
  against the server's own announced security value, so refusing to start adds no safety
  and enormous blast radius: a map that drifted in four rooms would cost twenty-one
  characters, every room, and everything that is not movement. `--require-map` (or
  `M59_REQUIRE_MAP=1`) restores the refusal for a machine that should not run a fleet it
  cannot fully validate. It is opt-in because the failure it prevents is smaller than the
  one it causes.
- **Drift is recorded and reported, not merely refused.** Every room whose live security
  disagrees with the bake is written down and surfaced on `/health` as `geometry_drift`
  and on `m59-service.mjs status`. A refusal says a character did not walk; the record is
  what says the WORLD changed, which is the half anyone can act on. Refresh with
  `node tools/setup.mjs server`.

**A LIVE ROOM ANIMATION BLOCKS MOVEMENT, AND THE BLOCK HAS TO EXPIRE.** `BP_SECTOR_MOVE`
and the two collision-bearing `BP_CHANGE_TEXTURE` forms set `room.collisionInvalidated`,
because the stock client mutates its in-memory BSP on those packets and we cannot. The
refusal is right. **Refusing for ever is a cage**: the flag is cleared in exactly one
place — `BP_PLAYER`, which arrives on a ROOM CHANGE — and changing rooms requires the
movement the flag refuses. Any room that animates a sector traps whoever is standing in
it until a restart, a death or a teleport.

That is not hypothetical: within ten minutes of shipping it, Bunsen and Rizzo were held in
North Barloque and Scooter in room 589, each reporting `could not reach the bank` six times
over. So the record carries `until` (`M59_COLLISION_ANIMATION_MS`, 8s) and the check honours
it — while a record with **no** `until` still blocks, because "we do not know when this ends"
is not "it has ended".

Two things to know before editing that path:

- **`validateFineTarget` and `queueValidatedMove` are LIFTED OUT OF `m59-broker.mjs` BY
  TEXT and evaluated** by `m59-collision-test.mjs`, because the broker cannot be imported
  without taking the fleet lock. So **any module-scope symbol either of them calls must be
  declared in that test's `dependencies` map** — a free identifier that is fine at runtime
  is a `ReferenceError` in the test, which is how this was caught. `validateFineTarget`
  stays PURE and returns its evidence; the caller writes it down.
- **The map costs real memory.** Measured on this machine: 26.8 MB on disk, **5.6 s and
  ~399 MB RSS** to load and validate 264/264 rooms at broker start. The PR that introduced
  it measured 3.2 s and 303 MB elsewhere, so budget for the machine rather than the number.

`node tools/m59-collision-test.mjs` (153) pins it, and **10 of those skip without the raw
`.roo` files** — set `M59_ROO_DIR` (or `M59_ROOT`) to a tree containing `resource/rooms`
or the suite quietly reports 137 and calls it a pass.

**AND ALL 153 OF THOSE ASSERTIONS ARE POSITIVE, WHICH MEANS THE SUITE PASSES CLEANLY ON THE
DAY THE WALLS STOP WORKING.** Brownestone's doorway, the Limping Toad's half-wall, Icky,
Farol, Ukgoth, Cor Noth, the Temple, the Fey precision cases — every one of them asserts
that a legitimate move REMAINS USABLE. That is the right thing to protect and it is half a
contract: a bake exists to REFUSE, and nothing was testing the refusing.
`node tools/m59-impossible-test.mjs` (126) is the other polarity — checked-in fine traces
across the King's Way, both Cragged Mountains, the Twisted Wood and its western border,
Ukgoth, the Sentinel, the Icky Cave and the four floors of Castle Victoria, each asserting
a refusal AND naming the wall index that refused it, so "still refused, for a completely
different reason" cannot pass as unchanged. It carries **controls in the same rooms out of
the same bake**, because a suite that only asserts refusals passes perfectly when
everything is refused, which is the fleet standing still. And **observation cannot be the
oracle here**: players legitimately appear to phase through walls from another client's
view — that is lag compensation — so "I watched it happen" proves nothing about legality.
Assert against our own validator, which is the only thing this repository controls.


## The fine grid is the reality; a square is a summary

The coarse grid has one answer per square: walkable or not, and one floor height. That is a
fine index and a poor map, and on the ground this fleet keeps failing on it is simply false.

Measured in room 579, An ancient place, its origin forgotten:

| square | what the coarse grid says | what is actually there |
|---|---|---|
| `r40c52` | `walkable: true` | **no floor at its centre.** 21 of 49 sampled interior points are standable; the middle is not one of them |
| `r38c30` | `walkable: false` | a sliver at 8000 you deliberately jump onto — 14 of 49 points |
| `r40c33` | one height | spans **3520 to 10880** — the valley floor and the high ledge, in one square |
| `r47c40` | one height | a ramp, 7600 to 10752 |

Three failures in one day came from forgetting this, and they look nothing alike:

1. **A walker aimed at square centres stepped off the ledge.** `walk_to` takes col/row and
   aims at the middle, which is right in a room and is the drop on a ledge. A character
   walked thirteen waypoints of the Ancient Place climb and then walked into the air.
   `walk_to` now takes fine `x`/`y` for exactly this.
2. **A jump finder could not see the first jump.** Searching for cross-region hops on the
   coarse grid cannot find `r40c33` → `r40c32`, because both the take-off and the landing are
   inside squares the grid gives a single height to. The whole jump is sub-square.
3. **A height profile read off single fine points swung by 7000 units.** One unit either side
   of a ledge edge is a different sector, so sampling the exact point a client asked to move
   to reports the valley as often as the ledge. A body has width; sample its footprint, or do
   not report heights at all.

The rule that follows: **squares are for talking to humans and for indexing the bake. Fine
coordinates are for deciding anything.** Where to stand, whether a step lands, whether a jump
clears, how high something is — ask the BSP at fine resolution, through `leafAtClient` and
`floorBaseAtClient`, not `walkable(row, col)`.

And the corollary that made the Ancient Place climb solvable at all: **a fall is a wall.** A
ledge is not something to detect — it is what REMAINS when descending is forbidden. Running a
never-descend closure from the bottom of the climb reduced 1,660 walkable squares to a
41-square ribbon and reproduced a route the operator had walked, to an average of 0.79 squares
across nineteen recorded positions. The operator's phrase for it is the right one: these are
all just constraints in the bot's head.

## A rule the game does not have deletes ground, and the ground it deletes is a corridor

`_occupiable` — the predicate under `standPoint`, and therefore under everything the router
and the mover agree about — required a sector to be **taller than the player** before a body
could stand in it: `ceiling - floor >= PLAYER_HEIGHT` (768). Meridian 59 has no such rule.

The client tests height in exactly one place, at a wall crossing, and only when the wall
carries an above texture (`clientd3d/move.c:551`):

```c
(sidedef->above_bmap == NULL ||
 (sidedef->above_bmap != NULL && wall->z2 - z >= player.height))
```

That is the wall's upper edge against the player's **feet**. Nothing in the client, and
nothing server-side — `UserMove` bypasses `ReqSomethingMoved` — ever asks whether a body fits
under the ceiling it is standing beneath. `canCrossWall` already implements the real rule
faithfully, gating on `!sd.aboveType`; the standing test was a second, invented one.

**What it cost: the 52 -> 110 and 2 -> 110 legs, permanently.** Room 108's jump take-off at
`r29c43` is entered by a sewer pipe at col 47, rows 35-42 — eight squares of dead-flat floor,
961 of 961 fine points standable at one uniform height, with 704 units of headroom. All eight
were refused, `standPoint` returned null for every one, and the only way in vanished. The
take-off was stranded on a 12-square island no anchor reached, the bake wrote *"no baked line
to the anchor 21,37"* 91 times (`row,col`, or `r21c37`), and those two legs never completed
once in any run. The jump itself was never the problem: placed on the ledge,
`m59-jumptest.mjs` clears it 3 for 3.

Removing the invented rule returns 1.15% of the world — 3961 squares over 74 rooms — and
joins the take-off to room 108's body (578 -> 604 squares, 66 fragmented regions -> 29).

**HEIGHT DOES NOT SORT WALKABLE FROM UNWALKABLE, which is why no threshold is the answer.**
The rule was introduced on one counter-example: The Queen's Way `r22c10`, 512 units of headroom,
found on inspection to be the inside of a locked tower. But the distribution under 768 is a
continuum, and most of it is ground people walk on daily — the General Store of Jasper is
672, East Ende is 640 across 354 squares, The Hungry Vaults 592 across 308. There is no
number that keeps the tower out and lets the shop in.

**ENCLOSURE is what separates them, and the trace already decides enclosure.** Under the
corrected predicate the locked tower is a *sealed one-square region*: nothing steps into it,
because the walls around it are not crossable. An isolated pocket no route reaches costs bake
time. A deleted corridor costs a leg that can never run. That asymmetry is the whole argument
for `standable`'s stated posture — permissive here, because the trace is the real gate.

Filler sectors are still refused: the room compiler emits solid space outside the room with
`ceilingHeight` equal to `floorHeight`, and `ceiling - floor > 0` excludes all 3655 of them.

**A predicate change invalidates every baked step mask**, and the manifest cannot see it —
it hashes geometry, so a stale table verifies perfectly while encoding the wrong doors. That
is what `STEP_MASK_VERSION` is for; this change took it to **6**. Until the rebake lands the
router degrades to coarse-grid planning, which is *more* permissive, not less: the routing
suite's room 27 fixture starts offering the stranded 2500 boundary. Rebake before reading any
routing result.

## The bag of tricks for traffic, and the one that was missing

When something is standing in the way, the walker has a ladder: wait a lap (six laps if it
is a player -- see `QUEUE_PATIENCE`), then `sidestepAround` tries the squares either side,
then under fire it backs up to make the body follow, then it marks the square taken and
replans. A separate trick, `needle_backoff`, handles a *doorway* that publishes a single
staging square.

**Every rung of that ladder thinks in SQUARES, and that is why a one-square corridor was
unsolvable.** There is no side square. So the walk fell through to writing the square off,
and A* was asked for a route through a corridor with a hole punched in it.

`tools/fixtures/sewers-108-row27.json` is seventy seconds of the failure, recorded: six
giant rats one per square centre on row 27 of the Sewers, one square apart, that **never
moved**, while three characters oscillated in the gaps and not one of them got past.

The arithmetic says they should have. Taken from the recording, in wire units:

| | |
|---|---|
| corridor floor | y 1728 .. 1792 — 64 units, exactly one square |
| a body fits between the walls | y 1743.5 .. 1776.5 (`PLAYER_RADIUS` 15.5 off each) |
| a rat sits at | y 1760, blocking within `MIN_NOMOVEON` = 16 |
| so a pass needs | y ≤ 1744 **or** y ≥ 1776 |

Each window is **half a unit wide**, and the wire carries integers — so there is **exactly
one aim point on each side: 1744 and 1776**. The square's own centre is not one of them,
and the square centre is what the walker aims at. That is the seventy seconds.

**So the trick is: the pass is not a different square, it is a different fine `y` inside the
same one.** `lanePastBodies` (in `m59-roo.mjs`, shared with the fall lane so there is one
answer rather than two) shifts the step sideways, nearest offset first, keeping a lane only
if both ends still have floor. `Session.laneAroundBody` applies it to an ordinary step, once
per blocked square, *before* the square is written off; a refused lane costs one step and
falls through to the old recovery. The tactic is recorded as `body_lane`.

`node tools/m59-lane-test.mjs` pins all of it against the recording, including that the
straight line through the rats is refused and that cols 39-41 really are one square wide on
the baked map.

**What it is not.** It does not help when the corridor is genuinely narrower than a body,
and it is an aim rather than a promise — `_traceMoverStep` still decides whether the step
lands. It also does nothing about a body that is *hitting* you: that is `underFire`, and the
answer there is still to move, not to thread.

## Exits, reach and the safe wall

- **EXITS ARE NOT DOORS, AND THEY ARE NOT 1:1.** Walking from room A to room B through
  an edge does NOT put you where the return trip starts. You arrive somewhere in B, and
  the edge back to A can be a long way from there — often most of a room away. There is
  no turning round and stepping back through the way you came.

  This breaks the intuition every routing bug in this repo has been debugged with. A
  route that worked outbound failing on the return leg is the NORMAL case, not evidence
  of a one-way door, a broken boundary, or an unmapped region. `no floor anywhere on the
  <dir> boundary` in particular means only that the boundary column the router chose has
  no standable square — the connection can still be perfectly traversable by walking to
  where the real exit actually is.

  Do not conclude "unidirectional travel" or "sealed area" from a failed return trip.
  The map graph records that A and B connect; it does not record that the two ends are
  in the same place, and they usually are not.

- **AN EXIT REFUSAL IS NOT PROOF THAT THE EXIT REFUSED.** Resting sets `PFLAG_NO_MOVE`, so
  a seated character can fail every ordinary approach step without ever sending the one
  off-map packet that asks the server to cross a declared edge. `Session.leaveVia` therefore
  stands before rail boarding or any other approach movement. The failure record keeps
  `stage` (`walk` or `edge`) and `crossing_packet_sent`; only `stage: edge` with
  `crossing_packet_sent: true` means the crossing packet was actually sent.

  When the bounded candidate budget is spent, `leaveViaAny` returns
  `outcome: exit_candidates_exhausted` with separate `attempts`, `tried`, and `skipped`.
  Travel may block that exact directed hop (`from>to`) for the rest of the current journey.
  It never persists a declared edge as bad, and it never blocks the destination room as a
  whole. If the router has no strict alternative and offers the same exhausted hop again,
  travel stops before another boundary walk with
  `outcome: route_progressing_exits_exhausted`. That is a bounded executor result, not a
  claim that the map has no door.


- **A BODY IN THE WAY IS NOT A WALL, AND IT IS NOT A CLEARANCE EITHER — IT IS A SLIDE.**
  `clientd3d/move.c:666-697` is the whole rule, and three separate models of it shipped here
  before anyone read it. Walls are swept by `FindIntersection`; **objects are tested only at the
  ENDPOINT of a move**. You may END inside the exclusion zone provided you are farther from the
  obstacle than you were (`"Allowed to move away from object"`). And when a move really is
  refused, the client does not refuse it — it **clamps one coordinate to the obstacle's centre
  plus or minus `MIN_NOMOVEON`, re-checks the walls, and returns `MOVE_CHANGED`**. X in
  preference to Y, which is not symmetric.

  Three consequences, each of which cost a session:

  - **`MIN_NOMOVEON` is 16 kod and it is ONE exclusion zone, not two player radii.**
    `PLAYER_RADIUS` (15.5 kod) is the WALL rule and a different question. Adding them gave 32,
    double the truth, and made a corridor the operator had walked by hand read as impassable.
  - **"The line must stay 16 clear of every body" is an invention.** It is not in the client and
    it refuses crossings the game allows. Two bodies 25.3 apart cannot both be cleared by 16, so
    that rule calls the gap shut; the gap is crossed by twelve consecutive legal slides, and was
    walked on the live server with the stock client while recording.
  - **The approach heading decides it.** The slide clamps toward whichever side of the obstacle
    the attempt landed on, so a body arriving four units too far west grinds up the near face for
    ever while one four units east goes through. There is no clearance number that expresses
    this; ask `bodyWalkArrives`, which walks the leg the way the client walks it.

  `resolveBodyMove` and `bodyWalkArrives` in `m59-game.mjs` are the transcription, and
  `m59-collision-test.mjs` pins each line of it against the case that caught it.

- **"ONE SQUARE WIDE" IS A STATEMENT ABOUT THE COARSE GRID AND USUALLY NOT ABOUT THE FLOOR.**
  The Western border of the Twisted Wood pinches to row 29 alone at columns 44-46 — on
  `geo.walkable`. The .roo underneath is **82 to 110 fine units** across those columns against a
  square's 64, and at column 46 that is nearly two squares of floor the byte grid does not
  mention. A search confined to the coarse row therefore misses lanes that exist, which is
  exactly the failure the capitalised rule at the top of this file warns about, made by a file
  that quotes it. Use squares to index the bake; ask the BSP where the floor is.
- **MELEE REACH IS A DISC OF RADIUS 2–3 SQUARES, AND FINE COORDINATES DO NOT EXIST TO IT.**
  Both sides run the same test: `SquaredDistanceTo <= GetAttackRange^2`, where the
  distance is `(piRow-row)^2 + (piCol-col)^2` on **square** coordinates
  (`nomoveon.kod:121`) and the range is `Bound(2 + viDifficulty/6, 2, 3)` for a monster
  (`monster.kod:1682`) or 2–3 by weapon type for us (`weapon.kod:52`). So up to 28
  squares can hit you, not the 8 that touch you.

  `piFine_row`/`piFine_col` exist on every object and **nothing about being hit reads
  them** — the only consumer in the whole tree is `MonsterOrient`, choosing the angle a
  monster is *drawn* facing (`monster.kod:2189`). Standing hard against a wall inside a
  square is therefore worth exactly nothing, and an earlier "hug the wall by 24 of 64
  fine units" change was inert by construction. Do not reach for sub-square positioning
  to explain a safe spot; the answer is always in the squares.

- **A SAFE WALL IS THE TWO GRIDS DISAGREEING, AND THAT IS MEASURABLE RATHER THAN POETIC.**
  This started as an operator's hunch — that safe spots turn up exactly where the coarse
  walkable grid and the client's BSP disagree — and the recorded book bears it out.

  "Disagree" means: the one-byte-a-square grid offers a neighbour that
  `traceFineMoveClient` refuses. Measured across every tested square in
  `substrate/m59-safespots.json`:

  | | at a disagreeing square |
  |---|---|
  | squares that HELD | **44.0%** (405/920) |
  | squares that FAILED | 34.5% (688/1997) |
  | ordinary floor, same rooms | **23.9%** (3249/13594) |

  And it is dose-responsive, which is what makes it a mechanism rather than a coincidence
  — by how many of the grid's neighbours the BSP refuses:

  | refused | held |
  |---|---|
  | 0 | 28.2% (515/1824) |
  | 1 | 26.6% (175/657) |
  | 2 | 49.1% (141/287) |
  | 3 | 55.2% (58/105) |
  | 4+ | **70.5% (31/44)** |

  Not a room-level confound: comparing high- against low-disagreement squares WITHIN each
  room, 12 rooms favour it, 3 go against and 2 tie.

  **The mechanism is the asymmetry below, seen from the other side.** A square the BSP
  hems in is a square whose lines to the surrounding floor are broken — and it is exactly
  those lines that `Room.LineOfSight` tests for the monster and nothing tests for us. The
  disagreement and the safe wall are one geometric fact.

  Two things follow. A safe spot is **predictable from geometry** rather than only
  discoverable by standing somewhere and being hit for it, which is what the book pays for
  today. And the routing fragmentation those same disagreements cause is mostly harmless —
  it is tiny dead corners, not severed halves of a room — so it is a poor reason to refuse
  a route and a good reason to rank a wall.

- **The safe wall is an asymmetry in who checks line of sight.** `Monster.CanReach`
  calls `Room.LineOfSight` (`monster.kod:1782`); `Player.TargetWithinSightAndRange`
  (`player.kod:4115`) checks range and a facing cone and **never calls it**. So a square
  whose line to a patch of floor is broken, while that floor is still inside your weapon
  range, lets you hit what stands there and take nothing back. `free_shots` in
  `m59-safespots.mjs` counts exactly those. Only lich and revenant ignore walls
  (`AI_FIGHT_THROUGH_WALLS`).

  **And a blow already in the air is not the wall's fault.** Being hit is resolved on the
  server and reaches us as a packet; our arrival travels the other way. So a blow resolved
  while we were still a square short can land after we have reported standing on the spot,
  and the reading blames the square. A failure is **permanent** (`discredited()`), so one
  such reading retires a good square for ever and nothing about it looks wrong afterwards.
  `SETTLE_GRACE_MS` (250ms, `m59-autopilot.mjs`) discards any window that opens before we
  have been settled that long, measured from the LATER of "stopped moving" and "claimed
  the square". Both clocks, because the walked-in path was already covered by accident —
  `takeSafeSpot` stamps `movedAt` on arrival, so the first window is thrown out for "we
  moved" — while `steps_away === 0`, claiming a square we were already standing on, walks
  nowhere, stamps nothing, and opened a countable window the instant the hold was taken.

  The window is **discarded, not forgiven**: the same packet delay that hides a hit until
  later is what would make the square look quiet now, so a reading we will not trust for
  damage is not one we may trust for proof. And the grace is deliberately narrower than
  the round trip can be, because the asymmetry runs the other way — being wrong about a
  bad square costs a character, being wrong about a good one costs a walk to the next
  corner. `settled_ms`/`min_settled_ms` are recorded on every real failure so the width
  can be argued from the record rather than from intuition; widen it only against those.

- **A PLANNED TRIP ACCEPTS THE RISK OF DEATH, AND ABANDONING ONE IS NOT AN OPTION. THE WAY
  OUT OF AN ATTACK DURING TRAVEL IS ALWAYS THROUGH.** When a journey is planned the risk is
  taken at that moment; a character being attacked on the way does not get to reconsider it.
  It completes the journey AS FAST AS POSSIBLE WHILE BEING ATTACKED. It does not stop to
  fight, it does not turn back, and nothing else may cancel the trip on its behalf.

  This is doctrine, not an optimisation, and it is written down because the obvious-looking
  fixes all violate it. Two were tried here on one afternoon and both were reverted: giving
  the character back to its keeper when health dropped below a threshold (that ends the
  trip), and putting a timeout on the errand's calls so a "hung" leg could be retried (that
  was a fix for a hang which, on inspection, had never happened). A trip that is abandoned
  costs the character its armour money AND leaves it wherever it stopped, which is usually
  worse than the room it was walking to.

  **AND `ms_since_moved` IS ABOUT THE KEEPER, NOT THE CHARACTER — it is what made both of
  those look justified.** A post-mortem showing `doing: "stalled"` with eight minutes since
  it last moved reads exactly like a character standing still being eaten. It was not: the
  frames put that character in three different rooms over the same span. The field measures
  when the KEEPER last moved it, and during an errand the keeper is inert by design, so the
  number climbs while the errand walks. `watchdog.stood_down_for` on the same record says so
  outright, and `pass_blocked_ms` was 5.6 seconds rather than the eight minutes the other
  field implied. Read those three together or the instrument will invent a stall for you.

  What actually happened is what the doctrine describes: an errand walked a character at 1
  of 49 health through rooms holding six to nine things, and it died going through. That is
  an accepted outcome of a planned trip, not a defect to engineer around.

## Two rules of the road in a one-square pipe

Both from the operator, 2026-09-01, after tour 6 of the shadow fleet timed out seven legs in
the Sewers of Barloque and wrote 200 of its 321 perp-walk rows there.

**A logoff ghost has no collision, and neither does an item on the ground.** In the kod a
`LogoffGhost` is a plain `ActiveObject`, and `Object` sets `viObject_flags = 0`, which is
`MOVEON_YES`; only `NoMoveOn` and its descendants (monsters, players) set `MOVEON_NO`. The
client walks straight through both. So every body list the walker builds goes through
`blocksMovement(flags)`, which reads exactly that bit — `bodiesInSquare`, the lane and perp
finders, the tracer's obstacles, the kill-and-continue blocker. The one place that did not was
the "is the next square still occupied" test that gates the breadcrumb retreat: it counted
ANY object, so a mushroom on the next square read as a crowd that never left, and the walker
backed off three crumbs for it on every attempt. It now asks `blocksMovement` like the rest.
If a ghost ever does block a step, the test is its flags on the wire, not its class.

**Keep to the right wall for your own direction of travel.** A sewer pipe is one COARSE
square wide — 64 fine units — and a character is a disc of radius 15.5 that blocks another
at 16 between centres (`MIN_NOMOVEON`). So a pipe fits two lanes: a body two units off each
wall leaves 29 between centres, nearly twice the blocking distance. Two characters that both
aim at the square's centre line meet nose to nose and stall, which is what both recorded jams
show; two that each keep right pass like ships in the night. `keepRightAim` in
`m59-roo.mjs` is the pure rule: probe the floor along the right-hand normal of the direction
of travel — `(-uy, ux)` in the game's y-down coordinates — and its opposite, and if the floor
is no wider than a square and a half, aim `right - 15.5 - 2` along the normal from the stand
point. `aimInto` in `m59-game.mjs` takes that lane as its FIRST choice, bodies in the square
or not, whenever the tracer says the lane point is reachable and (with a body present) it
clears the body; wide floor gets no lane and the stand point is what it always was. It is
always on, because the character coming the other way is usually not visible yet when the
lane is chosen, and because a rule of the road only works when every keeper follows it;
`M59_KEEP_RIGHT=0` is the only way off. Measured on the real BSP: the sewers' row 27 and
`r59c35`, and the Flatlands' row 35 up to `c33`, are 64-wide corridors with lanes 29 apart
each way; room 537, which had 95 perp-walk rows in the same tour, has 2,450 floor squares and
no corridor at all, so its jams are bodies on open floor and this rule does not touch them.
One `keep_right` row per room per session goes to the tactics ledger, with the corridor's
width and the offset taken, so a tour says which corridors were laned without a row per step.
`m59-lane-test.mjs` pins the geometry: east keeps south, west keeps north, south keeps west,
north keeps east, the lanes clear the walls and pass each other, wide floor and a slot too
narrow to shift in both keep the stand point, and the Flatlands fixture's own floor gives a
lane each way.

What it does NOT solve: a convoy of fleet-mates all going the same way down the pipe still
queues behind its own head, and a pipe full of rats is still a pipe full of rats. Those are
the perp walk, the walker's blink ask and kill-and-continue, above.

## The exit is a wall

Operator, 2026-09-01. A retreat on a journey looks for the nearest safe wall; **the room's
onward exit is one of them**. Crossing a room boundary breaks every attack on you, which is
the property a wall is chosen for. What the exit lacks is a place to heal, and the **first
available wall in the next room** supplies that — nearest by distance, no forward bias, and
never the next exit, so a retreat cannot chain room to room. It is a stopover, not the
destination; the journey resumes from it.

`nearestSafeSpot` adds the onward square to its candidates with `kind: 'exit'` whenever a
journey names one (`allowExit: false` withholds it, which is what the far-side search
passes), ranked like any wall: its walk counts against it and its progress — of which it
has the most — counts for it. `takeSafeSpot` sees the kind and crosses instead of standing:
one hop on the journey's own `travel` machinery, then `takeSafeSpot` again on the far side
with `nearestOnly`. A crossing that does not happen is a refusal that says so, never a hold
on a square in another room. The walker's wall-then-blink branch checks for it too: a wall
that turned out to be the exit means the walk ends with `left_room` and nothing is cast.

**And a correction from the same day.** When the forward preference was added, "can come
back" was redefined as "can reach the exit". From a pocket that cannot reach the exit at all
that rejects every wall as one-way — reproduced offline in the Cragged Mountains from
`r30c25`: 185 of 196 walls unreachable, two eligible without an exit named, **none** with one
— and a character under attack was told "nothing in this room is more defensible than open
floor" in a room with sixteen walls on file. The rule now: a wall we can walk back from is
always eligible; reaching the exit is an ADDITION, and only that kind earns the forward
bonus. The refusal carries its counters (considered, reachable, one-way, eligible) so the
ledger cannot say "no walls" when it means "no walls from this pocket".
`m59-forward-shelter-test.mjs` pins both.

## The needle has a clock

`threadInto` is the solver `step` runs on top of `aimInto` whenever the next square holds a
body: goal points on a fine lattice, each proven by a fine-move trace and a body walk, then a
multi-leg search through staging points with a work budget of 8000 legs. The budget never
covered the direct phase — up to 256 goals, each with an entry check of up to 64 more legs —
and in a crowded room that was thousands of traces per step. Measured 2026-09-02 by the
keeper's own profiler ([`docs/m59-keeper.md`](m59-keeper.md#a-stall-names-its-own-cause)):
29 seconds in one call, and the whole of every event-loop stall that remained once the aim
search was bounded.

So the needle has a wall clock: `M59_NEEDLE_MS` (400 ms; 0 removes it) across the whole
call, honoured by the entry check through `_needleDeadline` on the session so the signature
the fixtures lift is unchanged. A needle that has not threaded in that long is a jam, and a
jam is what the walker's other tactics — lane, perp walk, kill-and-continue, the blink ask,
the retreat — are for. It answers `blocked` honestly, and a throttled `needle_budget` row
says the clock cut it.

Two smaller bounds landed with it. `aimInto`'s body-aware search orders its 225 candidates
by drift once, so the first that arrives and holds is the best and the loop stops there, and
no candidate is traced twice across its two passes; a cap on traced candidates
(`M59_AIM_TRACE_CAP`) exists but is OFF by default, because tours 9 and 10 died more with one
on and the fleet's max health was decaying at the same time, which is not a measurement.
And `World.room`, which rebuilt and scanned the rooms array on every access, is memoised on
the client's room identity.
