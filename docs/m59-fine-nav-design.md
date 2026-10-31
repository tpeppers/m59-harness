# Fine navigation: route and move on footings, not squares — Stage 1 design

**Status: the bake, its loader and its query are BUILT (operator's Stage 1, 2026-10-31) — see
"Built" directly below. Nothing in the router or the mover has changed and nothing on the hot
path reads the graph.** The research sections (a)-(e) that follow are the 2026-10-30 design
and are kept as written; their numbers came from `tools/m59-finenav-measure.mjs` on
`origin/main` at `8890cc41`, run offline at below-normal priority while the prod fleet was live
(so absolute timings are upper-ish; ratios are the point).

## Built: the footing bake, the loader and the query

| file | what |
|---|---|
| `tools/m59-finenav-bake.mjs` | the bake. `--rooms 578,599 \| all`, `--jobs` (capped at 2), `--check`, `--out` |
| `tools/m59-finenav.mjs` | format, loader (`loadFineNav`, `fineNavRoom`), query (`footingAt`, `planFootings`, `legsOf`/`edgeLegs`, `planFine`), and `replayLegs` |
| `tools/m59-finenav-test.mjs` | 11 offline tests, registered in `m59-movement-suite.mjs` and `docs/m59-tests.md` |
| `tools/m59-peninsula-test.mjs` | the 578 case as a real assertion against the graph; the square-planner TODO stays a TODO |
| `tools/m59-finenav-measure.mjs --graph` | the AFTER half of the replay in (c) |
| `substrate/m59-finenav.json.gz` | the table: gitignored and derived, like `node-rails.json` |

**Format.** `m59-finenav/1`, `FINE_NAV_VERSION` 1, gated on `geometryManifestSha256`; a table
of another version or another geometry is refused whole (`loadFineNav`), as a stale step mask
is. Per room, base64 typed arrays: footing square, representative (two 6-bit wire offsets in
the square), floor, degree; edges as Uint16 (14-bit target, 2-bit kind); side tables for edges
that carry a landing (`aim`, `land` in wire units) and for edges that carry `via` points. Plus
`exits`, `stats`, `moving`, and `variants` (one full graph per baked door state).
**`standPoint`, `STEP_MASK_VERSION` and `m59-routes.json` are untouched**; the representative
rule lives only inside this bake.

**What the bake does, per room** (rules and reasons are in the file header):

1. *Samples* on a 256 lattice (4x4 a square), every point on the wire lattice. A sample is a
   place a body can be: floor, interior sector, not within 2 units of any wall line other than a
   step-compatible floor seam (so never on a one-sided wall), and four 2-unit probes free (so
   at least `PLAYER_RADIUS` + 2 from any wall that blocks it from that side).
   **Refinement:** a square is resampled at 64, then 32, when it has no such sample OR when
   it holds a floor band (heights within a step) that no sample is on — reading floors costs no
   trace. The second rule was found the hard way: 578's r32c46 is valley at 3200 with a 7072
   shelf through it that the walk to the south exit uses, and pitch 256 sampled only the valley.
2. *Footings* are the strongly connected pieces of the directed straight-trace lattice graph.
3. *Representative*: the member deepest inside the footing. Footing 0 of a square is the one
   that holds the square's legacy stand point (mutual straight walk), so `"row,col"` keys mean
   footing 0 and only multi-footing squares need `"row,col#k"`.
4. *Edges*, from the representative, to every footing in the 8 neighbour squares and the other
   footings of its own square, **proved with the live mover's options** (`queueValidatedMove`
   sends `slide: true` and rounds onto the wire toward the start; `landFrom` is that arithmetic
   aimed at a point):
   - `walk`: the move lands exactly on the target representative; or, when the two
     representatives cannot see each other, a sample of one that walks straight onto a sample
     of the other, joined to both representatives through the footings (`via`, pulled tight);
   - `slide`: it lands elsewhere; the edge goes to the footing the body is really in (a straight
     walk, or a walk through that footing's samples, reaches its representative) and records
     `land`;
   - `fall`: sent as a fall is sent, `slide: true, fall: true`, onto lower ground out to three
     squares; a fall that slides along the lip and lands elsewhere records `land` like a slide
     (82 of 535 falls in 578, 324 of 8,011 in 599). `timed` when the frame-by-frame fall
     (`m59-falltrace.mjs`, also `slide: true`) proves the same landing; plans use only timed
     falls unless asked (`falls: 'any'`). **No span gate**: `maxSpan` measures take-off to
     landing while `traceFallMotion` includes the level run before the lip, so it refuses real
     jumps (jump audit, 2026-10-31); the trace alone decides.
   - `slide:false` is kept for exactly three questions, all about place rather than motion and
     all stricter than the live mover: the clearance probes, the lattice adjacency and pulled
     chains inside a footing (an unobstructed straight trace arrives identically with slide
     on), and membership in `footingAt`.
5. *Exits* attach to footings: every footing in a `go` door's square; for an edge exit, the
   footing that reaches each published `fine_stand_on` (directly or along its samples) of the
   approaches `edgeCandidatesOf` says fire THAT exit, with the crossing target kept.
6. *Door states.* A room whose routing table has `stepMaskVariants` is baked again per variant
   on a private geometry (`applySectorHeights`). `fineNavRoom(table, room, {doorState})` returns
   that state's graph or refuses an unbaked one; without a state the base graph comes back
   flagged `door_state_assumed`. Moving sectors in `m59-variable-sectors.json` that no variant
   covers are recorded as `moving.unmodelled` and every plan in that room carries
   `unmodelled_moving_sectors` — never silently frozen.

**The query.** `planFine({geo, graph, from, goal})`: `footingAt` places the body (`member` —
it can walk to the representative and back — else `walk_in`, preferring a footing at the body's
own height so a first leg never steps off the shelf it is on), A* over footings, and legs that
are each proved from where the previous one leaves the body. Every miss falls back to the
square planner **flagged**: `source: 'square_fallback', fallback: true, fallback_reason`. Nothing
imports any of it from the broker, keepers, walker, world or routes (a test asserts this).

**Before / after**, the same replay on the same pairs (`--no-fine` for before, `--graph` for
after), all four rooms baked from the table on disk:

| room | two-step plans refused from the real landing — square / **footing** | anchor routes the body cannot follow — square / **footing** | footing plans that fell back |
|---|---|---|---|
| 578 | 1,682 of 85,648 / **0 of 142,937** | 8 of 15 / **0 of 15** | 0 |
| 599 | 467 of 203,859 / **0 of 404,241** | 1 of 8 / **0 of 8** | 0 |
| 2144 | 22 of 103,866 / **0 of 132,825** | 0 of 126 / **0 of 126** | 0 |
| 2154 | 309 of 332,411 / **0 of 514,371** | 6 of 151 / **0 of 151** | 0 |

Planning on the graph took a median of 0.1-1.7 ms and at most 12.7 ms per pair offline (A* over
footings, no traces but `footingAt`'s handful). Before the representative and refinement rules
above were in, 578 fell back on 2 pairs and 2144 on 1; those were the cases that found them.

**What "zero" means, honestly.** The replay sends every leg with the live mover's arithmetic
(`landFrom`: slide on, wire rounding toward the start) from where the previous leg really left
the body — but it is the same model of the client the bake used, on static geometry with no
bodies in the way. It proves the graph is consistent with the mover; it is not a walk on a
server. And it is a coverage claim only for these anchor pairs.

**Residue, reported rather than hidden:**
- `slide_unplaced` — slides whose landing no footing representative can be reached from, so
  they are not edges (578: 107, 599: 20, 2144: 11, 2154: 31). Conservative: a lost edge, never
  an unsound one.
- squares with floor but no body-clear sample even at pitch 32 (2144: 9, 2154: 1).
- untimed falls are excluded from plans by default (578: 5, 599: 23, 2144: 2, 2154: 46).
- plans are representative to representative, about a square a leg (1,014 legs for 578's
  15 routes): no string-pulled pivots yet.

**Deferred, on purpose:**
- **Declared fall-jumps** (`m59-falljumps.json`) are not edges: the file is under audit and
  was left alone. A route that needs one falls back, flagged.
- Pivots (string-pulled long chords proved at bake time), ceilings that move
  (`m59-ceiling-doorbake.mjs`), door states not in the routing table, the jump deviation
  solver (d), and every runtime consumer — Stages 2-5 of (e).

**Bake cost.** The four rooms: 61 s wall single-threaded, 17,792 footings, 147,197 edges,
0.38 MB on disk (0.81 MB JSON). **All 264 rooms, `--jobs 2`: 7 min 9 s wall** (704 s of
per-room work), 85.3M traces; 348,821 standable squares, **374,199 footings** (27,016 squares,
7.7%, hold more than one), 28,495 square refinements, 4,612 squares with floor but no
body-clear sample; **2,920,791 edges** (2,644,013 walk of which 7,169 through samples, 19,332
slide, 255,419 timed fall, 2,027 untimed fall; 7,293 slides unplaced); 15 door-state variants.
**13.83 MB of JSON, 6.06 MB gzipped on disk** (`substrate/m59-finenav.json.gz`, gitignored).
Exits that attached to no footing, in 3 rooms: 150 west->574, 537 north->536, 574 north->563
(no published approach whose stand point a footing reaches; every plan to them falls back,
flagged). Rooms with moving sectors no baked door state covers, flagged on every plan there:
35 (5, 47, 48, 60, 380, 532, 568, 589, 598, 701-715, 750, 801, 802, 1006, 2151, 2500, 2505,
2507, 2508, 2600-2602). Re-replayed from the full table, 578 and 2144 are unchanged (0 refused,
15/15 and 126/126).

The operator's goal: bots stop getting stuck on geometry. The agreed design, restated as
claims this document either supports with a measurement or marks unverified:

1. Route and move on the client's fine geometry. Squares stay as an index, a human label,
   and the unit of the few constraints the SERVER genuinely keeps in squares (exit/door
   trigger squares, melee reach).
2. Height-aware: climbs over `MAX_STEP_HEIGHT` refused, falls one-way, slides inside the
   edge model.
3. Precomputed, not live. Only the first leg is refined live from the body's fine position.
4. Fall-jumps with built-in deviation, solved per jump in real time when something is in
   the way.

Units throughout: squares are `rNcM`; fine points are CLIENT/BSP units (1024 a square)
unless marked kod (64 a square). `row` is y, `col` is x. See `docs/m59-coordinates.md`.

---

## (a) Airborne control, from source

Source on disk: `C:\code\Meridian59` (the `tpeppers/Meridian59-deck` fork, HEAD `fe93b6c6`).
Line numbers below are that tree's.

**Yes, the stock client lets horizontal movement change while airborne, and horizontal
speed in the air is exactly ground speed.** There is no airborne state in horizontal
movement at all:

- `clientd3d/move.c:131` `UserMovePlayer(action)` runs every frame a movement key is held,
  and nothing in it asks whether the player is falling. The only early-outs are
  `effects.paralyzed` (`:152`), no frame drawn, remote view, and the teleport wait
  `now < next_move_time` (`:204`). `motion.v_z` is never read on the horizontal path.
- The heading is taken fresh every call from `player.angle` and the key (`:226-262`), so
  turning or strafing mid-fall changes the ground track mid-fall. **Steering mid-air is
  the stock behaviour.**
- The distance per call is `move_distance = 2 * MOVEUNITS` running or `MOVEUNITS` walking
  (`:184`, `:188`), scaled only by elapsed time (`:213-221`) and by **the wading depth of
  the sector under the body's (x,y)**, `GetPointDepth(player_obj->motion.x, motion.y)`
  (`:195-201`; `client3d.c:235` reads the leaf at the point and ignores z). So: same speed
  as on the ground — 5120 u/s running, 2560 walking (`m59-falljump-physics.mjs`) — with
  one curiosity: a body flying over a deep-water sector is slowed to 3/4, 1/2 or 1/4
  *while airborne*.
- Vertical motion is a separate integrator. `UserMovePlayer` never writes `motion.z`; it
  sets `dest_z` and starts a fall with `v_z = FALL_VELOCITY_0` only "if not already moving
  that direction" (`:412-422`), so holding a key mid-air does not restart or cancel the
  fall. `MoveSingleVertically` (`moveobj.c:291-319`, called from `ObjectsMove`,
  `moveobj.c:254`) applies gravity. `GameIdle` (`statgame.c:385-390`) runs the fall
  (`AnimationTimerProc`) BEFORE the move (`HandleKeys`) each frame — already modelled in
  `m59-falljump-physics.mjs` and `m59-falltrace.mjs`.
- While airborne the wall test uses the body's carried height:
  `z = max(motion.z, GetFloorBase(last_x,last_y))` (`move.c:286`) then
  `z = max(z, motion.z)` (`:371`), passed to `FindIntersection` -> `IntersectNode`, whose
  step test is `wall->z1 - below_height - z <= MAX_STEP_HEIGHT` (`:551`). That is the
  landing rule `fallenBy(t) <= drop + MAX_STEP_HEIGHT` the harness already uses.
- A body cannot move over a point with no BSP leaf/sector even in the air (`:289-296`);
  `traceFallMotion` returns `fall_lost_floor` for the same reason.
- The client reports position to the server at most once a second
  (`MOVE_INTERVAL 1000`, `:57`, `:745`). A fall lasts 0.3-1.4 s (measured below), so the
  server sees zero to two positions of a jump.

**Two corrections to the brief, from the same source.**

1. *The server does not check a player's move against walls, the walkable flag, or bodies
   at all on this kod.* `UserMove` (`kod/.../player/user.kod:2914`) ends in
   `Send(poOwner,@SomethingMoved,...)` (`:3106`) and never calls `ReqSomethingMoved`;
   `room.kod:2045` says user moves are "already checked by client (HAHA!)".
   `CanMoveInRoomFine` (`blakserv/roomdata.c:235`) is reached only through
   `ReqSomethingMoved` with `server_validate` (`room.kod:2100-2108`) — monsters and
   server-side moves. Its `monster_grid` is the room's STATIC per-square movement grid from
   the `.roo`, not occupancy. The server polices speed (`user.kod:2958`: running with vigor
   under `VIGOR_RUN_THRESHOLD` is snapped back) and logs teleport-like jumps; that is all.
   **Unverified: whether the prod server (76.214.42.186) runs this kod.** It is not ours.
2. *So monster occupancy enters through the CLIENT's rule, which the harness keeps
   voluntarily, and it is not "body radius 248".* `MoveObjectAllowed` (`move.c:617-716`)
   runs on every sub-step (up to 20 a frame, `:266`). For each `OF_MOVEON_NO` object it
   blocks a sub-step that ends within `MIN_NOMOVEON = FINENESS/4 = 256` (Euclidean, `:667-670`)
   of the object's centre **unless the step increases the distance** ("Allowed to move away
   from object", `:672-679`), pushes the point to the edge of a 256-unit box around it, and
   accepts that only if walls allow it (`:681-695`). It is two-dimensional: z is used only
   for the wall check of the pushed point. 248 (`player.width/2`) is the wall clearance.
   `m59-roo.mjs` `_resolveObjectMicrostep` already transcribes this rule exactly, and
   `traceFallMotion` passes `obstacles` through it every frame. The conclusion in the brief
   stands — a monster under the flight path stops or deflects the airborne body just as
   one on the landing does — but the radius is 256 about the monster, the approach half of
   the pass is what is constrained, and the authority is our own fidelity to the client.

**A third fact the jump design needs:** walls in this game are one-sided per sidedef.
`IntersectNode` picks the sidedef facing the move's start (`move.c:530-536`) and skips the
wall if it is null (`:540`). A point exactly ON such a wall can leave to either side;
a point beside it can approach from one side only. That is the actual mechanism of the 578
TODO (below), not a pinch.

---

## (b) How the existing pieces fit, and what is missing

### The node: a footing

A **footing** is a strongly connected piece of body-clear floor inside one square: sample
the square on a lattice, keep points where a body can be (floor, interior, and at least
`PLAYER_RADIUS` from any wall that blocks it), join neighbouring samples with a DIRECTED
edge when the body-radius trace walks straight from one to the other (step height
enforced), and take strongly connected components. Directed, because one-sided walls and
drops are directed; undirected union-find called 578's r2c10 one place and it is two.

The navigation node is `(square, footing)`. Squares stay the index. Measured over all 264
rooms at pitch 256 (4x4 samples a square):

| | value |
|---|---|
| standable squares | 348,821 |
| footings | 371,954 (1.07 per square) |
| squares with more than one footing | 24,486 (**7.0%**) |
| ...of which footings are > `MAX_STEP_HEIGHT` apart | 11,437 (3.3%) |
| squares with no body-clear sample at this pitch | 7,845 (2.2%) — narrow ground; needs refinement |
| straight footing-to-footing edges (8 neighbours) | 2,599,752 |
| cost | 36,984,117 traces, 185 s single-threaded |

Per room (pitch 256):

| room | standable | footings | >1 footing | >step apart | none at 256 |
|---|---|---|---|---|---|
| 578 Cragged Mountains | 2,450 | 3,261 | 543 (22.2%) | 471 (19.2%) | 0 |
| 599 Ukgoth | 4,686 | 5,276 | 498 (10.6%) | 420 (9.0%) | 0 |
| 2144 Clearing of the Trading Post | 2,285 | 2,307 | 26 (1.1%) | 15 (0.7%) | 19 |
| 2154 Avar Village | 6,735 | 7,050 | 285 (4.2%) | 227 (3.4%) | 8 |

578 and 599 agree with the routing doc's 21.8%/11.2% "floor layers". 2144's 6.5% there
counted layers whether or not a body could reach them; here the palisade top mostly fails
the body-clearance test, so it is 1.1%. At pitch 128 the "none" column for these four rooms
falls 27 -> 16 and footings rise 4%; cost rises 4.0x.

### What `m59-fineroute.mjs` already gives

- Fine waypoints with floor under them; walk legs alternating with jump legs — the output
  shape the executor should consume (`{kind:'walk', waypoints}` / `{kind:'jump', ...}`).
- Declared jumps as edges, with `reachableTakeoff` (the take-off at the take-off's own
  height inside a split square) and the declared point kept separately from the reached one.
- `proveCandidateFall` (timed-fall proof with integer wire endpoints) and
  `checkedWalkWaypoints` (string-pulling that only keeps chords the mover proves). Both
  should be reused unchanged for jump edges and for pivot pulling.

### Why it cannot be the primary planner as it stands

- **Its closure is a live flood, and it is 10-15x the cost of baking the whole room.** One
  closure (walk only), measured: 578 2.5-7.6 s, 599 0.2-6.7 s, 2144 ~7-8 s, **2154 29-35 s**.
  The whole room's footing graph (footings + straight edges) costs 1.0 / 1.6 / 0.8 / 2.4 s
  at pitch 256, or 2.7 / 7.0 / 3.5 / 10.2 s at pitch 128 — and is done once, offline.
- Its closure is a forward-reach set with unbounded descent from ONE start, not a graph:
  every start needs its own flood, and nothing can be baked from it.
- It has no exits, no learned refusals, no threat costs, no multi-room view.
- It is lattice-phase sensitive: walk-only it planned 15/15 pairs in 578, 126/126 in 2144,
  37/37 in 2154 (before its budget), but **7/8 in 599**, where the square router has the
  route. (Whether its plans walk end to end was not re-verified here.)

### What is missing to make footings the primary planner

1. **A bake**, `tools/m59-finenav-bake.mjs`, sibling to `m59-routebake.mjs`, writing
   `substrate/m59-finenav.json` (or a binary sidecar plus manifest) gated on
   `geometryManifestSha256` AND its own `FINE_NAV_VERSION`, refused wholesale when stale,
   exactly as `stepMaskCurrent` refuses a mask. Per room:
   - footings: square index, representative point (two 10-bit offsets in the square),
     floor height, sample count;
   - edges in CSR form, each with a kind: `walk` (straight, rep to rep), `slide` (aimed at
     a footing, LANDS in a recorded footing at a recorded point), `fall` (one-way,
     `fallTargets`-style, footing to footing), `jump` (a declared jump, by reference),
     `door` (footing in an exit square, or the stage footing of an edge crossing);
   - pivots: string-pulled chords between footing reps, each chord PROVED by the trace at
     bake time (see the 2154 hop finding below — interpolated hops are how chords cut
     ledges).
2. **Representative points that are never on a wall line.** Today's `standPoint` returns
   the square centre whenever the centre is floor, and 578 r2c10's centre is exactly on the
   one-sided wall at x=9728. Reps must have geometric clearance >= `PLAYER_RADIUS` from
   every wall that blocks in either direction (a probe-based test does NOT catch a point on
   a one-sided wall: a point on the line may leave both ways). This is a predicate change
   and therefore also a `STEP_MASK_VERSION` bump if the mask keeps using `standPoint`.
3. **Edges proved footing to footing by the same trace, and an edge carries where the body
   lands.** A slide edge's target is the footing the body actually stops in. That is the
   categorical fix: the next step is planned from where the body is, not from the target
   square's stand point.
4. **Adaptive sampling.** Pitch 256 everywhere, refined to 64 inside any standable square
   with no clear sample (2.2% of squares).
5. **Door variants.** `m59-doorbake.mjs` already bakes a step mask per door state; the
   footing graph needs the same per variant (only for rooms with variants).

### How exits attach, and how `World.path` / `walkTo` / `leaveVia` consume it

- A `go`/door exit square: every footing in it is a door node (the server judges the
  square — "the body leaves the room on arrival anywhere in it").
- An edge exit: the footing containing the baked `edgeApproaches` inside point is the
  stage node; the crossing aim stays the existing fine inside/outside pair.
- `anchorFor` keeps its contract (ask by destination) and returns `{row, col, footing}`;
  `reached_by` is counted on the footing graph backwards, as now.
- `World.path` / `geo.path` gain a fine entry, `navPlan(bodyPoint, goal)`: locate the
  body's footing (`footingAt`: nearest samples in height band, straight trace there AND
  back — under 8 short traces), A* over footings (node count ~1.07x squares, so the same
  cost as today's mask A*), emit legs with fine waypoints from the proved pivots, plus a
  `squares` projection for the ledger, telemetry and anything that still speaks squares.
- `walkTo` compares FOOTINGS reached, not squares; refusal learning records
  `footingA > footingB`; every replan starts from `footingAt(actual body)`.
- `leaveVia` walks to the door footing's rep (or the stage footing) and then sends the
  crossing exactly as now.
- First-leg live refinement is bounded: the body to its footing's rep, or straight to the
  first pivot if the trace proves it. No floods on the keeper loop.

### Every consumer keyed on squares, and how to avoid touching most of them

**Compatibility trick: footing 0 of each square is the footing that holds that square's
(fixed) stand point, and the legacy key `"r,c"` means footing 0.** New keys `"r,c#k"` exist
only for k > 0, i.e. in the 7.0% of squares that have them. Every existing key keeps its
meaning in 93% of the world.

What reads squares today (non-test tools; counts from grep on this tree):

- **`m59-roo.mjs` RoomGeometry**: `moverStepLands` / `_stepMask` / `buildStepMask` /
  `attachStepMask`, `neighbors()`, `path()` (`blockedEdges`, `avoid`, `extraCost`,
  `threats` all per square), `standPoint` / `standPointWire`, `fallTargets` /
  `declaredFallJumps` (keyed `"row,col"`), `_strandedByLanding`, `_standOnBoundary`.
  53 tools reference the step-mask API; 20 call `geo.path`.
- **`m59-routes.mjs` / `m59-routebake.mjs`**: route keys `fromRow,fromCol>toRow,toCol`,
  pivots `[row,col]`, anchors `{row,col}`, regions/components/reach per square, `bakedPath`,
  `anchorFor`, `anchorReach(Via)`, `bakedPivots`, `transitCost`, `sameRegion`, door-variant
  masks, lazy room artifacts. 13 tools consume the `bakedPath`/`anchorFor` family.
- **`m59-session-walk.mjs`** (`walkTo`, `step`, `walkPivots`, `followRail`, `railAcross`,
  `leaveVia(Any)`, `sidestepAround`, `learnDeviationEdge`): `blockedEdges` Set of
  `"r,c>r,c"`, the held-refusal cache, `impossibleHere`, occupied/avoid squares, arrival =
  in the target square. 9 tools build `r,c>r,c` edge keys (guildrails, navgeom,
  pocket-rails, roo, routebake, routes, session-walk, walksim, world).
- **`m59-world.mjs`**: `exits()` (`stand_on {row,col}`, `verified` via `path()`),
  `anchorContradictedLive`, `provenDoorsBeforeExempt`, `orderExits`, `mayArrive`.
- **Persisted, versioned contracts** (`docs/m59-coordinates.md`): `m59-standpoints.json`,
  `m59-gutters.json`, `m59-pocket-rails.json`, `m59-fine-guides.json`, `m59-tracks.json`,
  `m59-crossings.json`, `m59-falljumps.json`, `m59-oneway.json`, `m59-blink.json`,
  `m59-wedges.json`; travel-ledger `refusals[].square`; wrong-exit avoidance keys; safe-spot
  book and locked-door keys (`"col,row"`). These do NOT need to change: they name squares
  as places, and footing 0 is the place they meant.
- **Square-native analyses** (`m59-safespots.mjs` exposure/safe walls, `m59-safelegs.mjs`,
  `m59-overlay.mjs`, `m59-roomview.mjs`, `m59-clipsweep.mjs`, `m59-exitreport.mjs`,
  door bakes): keep squares; they read the graph through the projection.

### Bake cost estimate for all 264 rooms

| | measured / estimated |
|---|---|
| footings + straight edges, pitch 256 | **185 s** single-threaded (measured, 37.0M traces) |
| same at pitch 128 | ~12-13 min single-threaded (4.0x, measured on the four rooms) |
| slide-landing classification | ~+50% of the footing cost (the mask audit, a close proxy, cost 3.9 s against 5.8 s on the four rooms) |
| falls, declared jumps, doors, pivots | not measured; the current bake already does falls and pivots per square |
| **total** | **~15-20 min single-threaded, ~3-4 min with the existing `--jobs 8` pool** — same order as today's routebake (13 min / ~250 s) |
| size | 372k footings, ~2.6M straight edges. Naive CSR ~10 MB raw. With a per-footing 8-bit direction mask where the neighbour square has one footing (93%) and explicit targets only into multi-footing squares, ~3.5-5 MB raw. Today's `m59-routes.json` is 3.1 MB. Estimates, not measured. |

---

## (c) The measurement that defines success

`node tools/m59-finenav-measure.mjs --no-fine` (the four rooms, ~10 s). Three questions,
each asked of the mover's own trace with no obstacles and no live state:

1. **Two-step soundness of the mask.** For every step A>B the baked mask allows, where
   does the body really stop (`_moverStepFrom` from A's stand point), and does every step
   B>C the mask allows still land from THERE? The square planner assumes it does.
2. **Baked routes, followed by the body.** Each anchor-to-anchor route walked square by
   square from where each step really stops (baked falls traced with `fall:true`).
3. **Hops as `bakedPath` sends them** (pivots subdivided to <= 5 squares), each traced from
   the body's real position; a refused hop is skipped past, as `followRail` does.

| room | mask steps | deflected first steps | two-step plans refused from the real landing | routes the body cannot follow | ...that WOULD work from the stand point | hops refused |
|---|---|---|---|---|---|---|
| 578 | 15,204 | 941 | **1,682 of 85,648 (2.0%)** | **8 of 15** | 8 of 8 | 18 / 466 (geometry_blocked) |
| 599 | 32,800 | 921 | 467 of 203,859 (0.23%) | 1 of 8 | 1 of 1 | 5 / 244 |
| 2144 | 16,075 | 946 | 22 of 103,866 (0.02%) | 0 of 126 | — | 14 / 1,297 |
| 2154 | 50,245 | 929 | 309 of 332,411 (0.09%) | 6 of 151 | 6 of 6 | **55 / 1,298** (18 step_too_high, 37 geometry_blocked) |

Every route failure in every room is the same class: **the step lands from the stand point
the planner assumed and is refused from where the body actually is.** That is exactly what
`(square, footing)` nodes with landing-carrying edges remove. The success criterion for the
footing planner is: zero refused two-step plans and zero refused route steps on the same
offline replay, with no route lost that the square planner has (a lost route falls back to
the square planner, flagged).

**The 578 TODO, reproduced with numbers.** r2c11's stand point is (10752,1536); the step to
r2c10 aims at r2c10's stand point (9728,1536), slides, and stops at **(10080,1536)** — inside
r2c10 (x 9216-10240). r2c10's stand point lies exactly on wall 499, a one-sided wall at
x=9728 from y 1024 to 3072 (`negSidedef: null`). From (10080,1536) the straight trace west
is `geometry_blocked` by wall 499; from (9728,1536) east it arrives. `_moverStepFrom` from
(10080,1536) to r2c9 does not land, while the mask says r2c10>r2c9 is legal.
`_strandedByLanding` is skipped because `_standOnBoundary(r2c10)` is true. The audit finds
this triple on its own (`pinned TODO reproduced: r2c11>r2c10>r2c9`) among 1,682 like it in
578, e.g. r1c11>r2c10 stopping at (9984,1520).

**The 2154 hop-cutting finding, reproduced.** The 2026-10-29 Avar commit (`7edf9374`)
recorded 26 of 330 sent hops refused (step_too_high / geometry_blocked) on live sends.
Offline over all 151 baked routes: **55 of 1,298 hops (4.2%) refused, 18 `step_too_high`
and 37 `geometry_blocked`** — the same two reasons, lower rate because every route is
counted, not only the ones walked. Separately, 6 of 151 routes cannot be followed square by
square: all six break at r41c37, where the body stops at (36864,40960) — a square corner —
and the next step lands from r41c37's stand point but not from the corner.

---

## (d) The per-jump deviation subproblem

**When it runs.** The next leg is a jump edge, the body has walked to within about a square
of the take-off footing, and the live object snapshot holds an `OF_MOVEON_NO` body (monster,
or another player; fleet-mate exemptions as in `overlapExempt`) whose 256-unit disc meets
the default flight corridor, the take-off approach, or the landing area. With nothing in
the way the declared flight is used unchanged — no solve.

**What is already there.** `planDeclaredTakeoff` (`m59-jump-takeoff.mjs`) searches up to 576
take-off points on an 8-kod-unit grid in the take-off square's 3x3 neighbourhood with a
FIXED landing, rejects a lane within `MIN_NOMOVEON` of a body, proves each candidate with a
timed fall, and has a 500 ms budget. It is called from `m59-declared-crossing.mjs` and
`m59-brax.mjs`. The new solver generalises it: the landing varies too, and the budget is 20 ms.

**State space.** Take-off point p on the take-off footing (2D), landing point q on the
landing footing (2D); constant heading p>q at run speed (5120 u/s, requires vigor — the
server snaps back a run below `VIGOR_RUN_THRESHOLD`). A single mid-air bend is legal (source
(a)) and is v2 only, if straight tracks fail measurably often. No vertical control exists:
there is no jump button and the fall starts at `FALL_VELOCITY_0` downward.

**The terrain half is baked, per jump.** Measured on the 18 declared jumps
(`--jumps`): a timed-fall proof costs **0.1-0.6 ms** (one outlier 3.6 ms, 2505 r27c64);
sampled at 32 units, for the 11 whose declared proof arrives, the declared take-off reaches 31%-100% of the landing
shelf within 3/4 square of the declared landing, and the first miss is as close as **32
units** from the declared aim (579 r38c33>r38c31), 45 (108), 101 (2505 r27c64>r23c60).
So "land anywhere up to the edge of the ledge" is a real but sometimes thin margin. The
bake stores, per jump, K take-offs x M landings (e.g. 12 x 24) with a bitset of which pairs
the timed fall proves, the landing's distance to the shelf edge, and the bracket verdict of
`jumpConfidence` (all frame rates 8-100 ms must clear; a pair inside the bracket is not
offered).

**How bodies enter (live).** The client's rule, which the harness already models
(`_resolveObjectMicrostep`): a sub-step that ends within 256 of a body's centre and does not
increase the distance is pushed or blocked. So for each candidate pair, with the track
segment p>q and each blocker centre o: compute the closest approach on the segment. The
pair is clear if that distance is >= 256 + margin (margin = 32), or if the closest approach
is at p itself and the track moves away (the "moving away is allowed" half). Pure
arithmetic. The take-off approach walk (body to p) uses the existing `planBodyDetour`
(bounded nodes) only when the straight walk is blocked.

**The landing-edge constraint, with margin.** Among clear pairs choose by: (1) all frame
rates clear; (2) landing margin to the shelf edge >= 64, else the largest margin available
down to the edge — "it's gotta make the jump" — but never a landing sample the bake
recorded as a miss; (3) largest clearance from bodies; (4) shortest detour. Then one live
`traceFineMoveClient(p, q, {fall:true, timedFall:true, obstacles})` to confirm against the
current snapshot before sending, re-run on the next candidate if refused (at most ~10).

**Budget.** 288 pairs x <= 20 bodies of segment-distance arithmetic is ~6k operations,
well under 1 ms; up to 10 live proofs at 0.1-0.6 ms is under 6 ms; total < 20 ms on the
keeper loop. If no pair is clear: wait (bodies move; bounded) or raise the jump edge's cost
for this session and replan. Never jump into a body.

**Where it is called.** A new `planJumpDeviation(geo, body, jumpEdge, objects, {budgetMs: 20})`
in `m59-jump-takeoff.mjs`, called by the jump-leg executor (`m59-declared-crossing.mjs` and
the `Session.step` fall branch that today "waits/refuses a flight whose straight lane is
occupied") immediately before the run is sent, and again if the snapshot changes before
departure. Its output (p, q) feeds the existing `declaredJumpMoveOptions` aim.

**Found while measuring, needs reconciling before jumps become graph edges:** 6 of the 18
declared jumps are refused by the current timed-fall proof from their own declared fine
points (2502 r41c34>r44c27 [re-declared r40c33>r40c29]; 579 r40c33>r40c32, r38c31>r42c30, r47c39>r49c36, and the two
579 r15c55/56 > r8c55/56 entries, which are 4,416 units UPHILL and are evidently lift
rides, not falls); the two 599 jumps have no fine points and use stand points (r36c16>r38c10
refused). Several "proofs that arrive" have spans beyond `maxSpan` because `traceFallMotion`
walks over level ground between falls — they are timed walks, not single jumps. None of
this was investigated further; the live jump verb may succeed where this offline proof does
not.

---

## (e) Staged implementation plan

Each stage is shippable alone and leaves the fleet moving exactly as before unless its flag
is on.

1. **Bake, no runtime change.** `m59-finenav-bake.mjs` (pitch 256 + adaptive 64, clearance
   reps, directed SCC footings, walk/slide/fall/door edges, proved pivots), `--jobs`,
   `--resume`, manifest + `FINE_NAV_VERSION`. Tests: a synthetic one-sided-wall square, a
   raised peninsula, a split ledge square, a door square; `m59-peninsula-test`'s 578 TODO
   flips to passing **against the footing graph** (the mask test stays a TODO);
   `m59-finenav-measure.mjs` gains `--graph` and must show 0 refused two-step plans and 0
   refused route steps on 578/599/2144/2154. Not `#movement` (nothing moves differently).
2. **Shadow mode.** `M59_FINE_NAV=shadow`: the walker computes both plans and logs
   disagreements to the movement-incident ledger; behaviour unchanged. Run on the shadow
   fleet (`docs/m59-shadow.md`), not prod.
3. **Primary planner, room by room.** `M59_FINE_NAV_ROOMS=578,2154,599,2144` (opt-in list;
   unset = square planner everywhere). Order by measured need: **578** (8/15 routes
   unfollowable, 2.0% of two-step plans unsound), **2154** (55 refused hops; a farm room),
   **599** (hot crossing; must coexist with safe-legs), **2144** (nearly clean — the
   regression guard). This IS a `#movement` commit: the epoch tag resets every ledger keyed
   on it, fleet-wide, because epochs are per commit, not per room. Land it as one commit
   with the flag defaulting off, and turn rooms on by configuration so the epoch resets once.
   Tests: `npm run test:movement`, `m59-routing-test` (anchors still fire their own exit),
   `m59-collision-test`, `m59-walksim`, `m59-crossingtrial` in 599 on the shadow fleet.
4. **Jump deviation.** Bake the per-jump take-off x landing tables; `planJumpDeviation` with
   a test placing synthetic blockers on each declared jump's corridor and asserting p99 <
   20 ms offline; fix or retire the seven declared jumps the offline proof refuses first (six with fine points, plus 599 r36c16>r38c10 on stand points).
5. **All rooms**, square planner kept as the fallback that is flagged whenever used. "A bake
   must never be the reason a doorway disappears" still holds: no route on the graph means
   the square answer, marked.

**Risks.**

- *Predicate drift* — the graph and the mask are two bakes of one geometry; each refuses
  itself when stale, and the measurement tool is the cross-check.
- *Sampling misses narrow ground* — 2.2% of squares had no clear sample at 256; adaptive
  refinement plus the square fallback.
- *Fixing `standPoint` off wall lines* changes the mask predicate: `STEP_MASK_VERSION` bump,
  full rebake, door rebake, and compare against a fresh bake of the base, never the
  committed table (the routing doc's own rule).
- *Consumer churn* — 53 tools touch the mask API; the footing-0 projection keeps 93% of keys
  meaning what they meant, but `walkTo`'s arrival test and refusal learning must change.
- *Keeper loop* — per-plan A* is the same order as today; `footingAt` is a handful of short
  traces; nothing floods live. The live budget is the 20 ms jump solve and the first leg.
- *Door/moving sectors* — per-variant graphs multiply size in those rooms.
- *Evidence epochs* — a `#movement` commit resets the ledgers; the before-numbers here are
  offline, so they survive it.
- *Unverified:* prod's server-side move validation (the kod on disk does none); whether the
  live jump verb lands the six jumps the offline proof refuses; whether fineroute's walk legs
  are themselves walkable end to end (not replayed here); the bake size (estimated, not
  written).

---

## Reproducing

```bash
node tools/m59-finenav-measure.mjs --no-fine                    # the table in (c), ~10 s
node tools/m59-finenav-measure.mjs                              # + fineroute closures, ~5 min
node tools/m59-finenav-measure.mjs --rooms all --footings-only  # the map-wide survey, ~3 min
node tools/m59-finenav-measure.mjs --rooms 578,599,2144,2154 --pitch 128 --footings-only
node tools/m59-finenav-measure.mjs --jumps                      # the declared jumps, ~10 s
```

One at a time: it drops its own priority, but it still shares cores with the live fleet.
