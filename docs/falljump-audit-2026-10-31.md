# Fall-jump audit, 2026-10-31: the seven declared jumps the timed-fall check refuses

Read-only audit against `origin/main` at `7234d1dd` (worktree `m59-harness-jumps`).
Nothing in `substrate/m59-falljumps.json` or in any tool was changed. No keeper or broker was
contacted. The geometry is the committed `substrate/m59-map.json`. All coordinates are CLIENT
units (1024 to a square, `x` = col, `y` = row). A square is `rNcM` with N = floor(y/1024)+1.
Floors are client heights; kod heights are x16.

## The two proofs disagree, and neither of them is what the live mover runs

There are three checks in play:

| check | call | `slide` | span gate |
|---|---|---|---|
| `m59-finenav-measure.mjs --jumps` (feat/fine-nav) | `traceFineMoveClient(..., {slide:false, fall:true, timedFall:true})` | **false** | none |
| `proveCandidateFall` (`m59-fineroute.mjs`) | `traceFineMoveClient(..., {fall:true, timedFall:true})` | true (the default) | `span <= maxSpan(drop)`, plus a wire-rounded re-check |
| live executor (`m59-session-walk.mjs` -> `queueValidatedMove`) | `{slide:true, fall, timedFall, unclipped:true}` | **true** | none. `unclipped` refuses only when the end point is not the aim |

So the measure tool is stricter than the live mover: a fall that slides along a wall and still
ends exactly on its aim is sent live and refused by the measure tool. Three of the seven
"failures" (599, 579 r40c33, 579 r38c31) are only that.

`proveCandidateFall` adds a span gate. `traceFallMotion` runs across level ground before it
leaves an edge, so a trace can arrive with a span over `maxSpan`. Examples among the passing
jumps: 2505 r27c64>r23c60 is 5917 against 5116, 2505 r27c60>r27c65 is 5120 against 1774,
108 r29c43>r23c43 is 6144 against 1774, and 589 r35c16>r38c19 is 4480 against 3876. The span gate
refuses a declared pair whose take-off is a run-up instead of the edge. Two of the seven
(599, and Brax once the lift is applied) fail only on that gate.

Reproduce: `node tools/m59-finenav-measure.mjs --jumps` from the fine-nav worktree. The scratch
scripts used for everything below (`diag*.mjs`, `search.mjs`, `verify.mjs`, `trails.mjs`) called
`traceFallMotion(geo, ..., {slide})` and `proveCandidateFall` directly, at below-normal priority.

## Summary table

| # | jump | live record | why the proof refuses | verdict | fix |
|---|---|---|---|---|---|
| 1 | 2502 r41c34 > r44c27 | **prod 2026-10-27: 5 characters crossed, 0 failures logged** (trek / cave-walk logs; `walkHollowsOut` refines its own take-off, so the declared point was not the one jumped from) | Same-height points 7734 apart (drop 0, maxSpan 1415). The line falls into the 4800 pit and stops grounded against pit wall 21 (x=29184, 4800 -> 8000). The declared points are the start and end of a walk, not the jump | **points are wrong** | ramp top (31296,40128) f8465 r40c31 -> (29120,40128) f8000 r40c29: drop 465, span 2176/2344, passes all three checks |
| 2 | 579 r40c33 > r40c32 | **not seen on prod.** Shadow lab (local server) 2026-09-28: 3/3 complete node approaches crossed it; 5 trials in total | slide:false only: grounded at (32586,40224) z3520, wall 376. With slide:true the fall slides along wall 436 and lands exactly on the aim. `proveCandidateFall` PROVES it | proof too strict, or points too close to the wall | (33360,40464) f8640 -> (32496,40464) f7040: span 864/3876, passes slide:false, slide:true and `proveCandidateFall`. Both chords back to the old points walk |
| 3 | 579 r38c31 > r42c30 | **not seen on prod.** Shadow lab 2026-09-28: 3/3, landed exactly at (30320,42000)/4800 (`docs/reproductions/ancient-timed-fall-2026-09-28.md`) | slide:false only. The take-off (30720,38400) is 256 east of solid wall 399 (x=30464), just outside the 248 radius. Any aim west of due south enters the wall's clearance at the first frame: refused at (30713,38461), z8000, after 48 ms. slide:true slides down wall 399, waits under wall 407's 6080 ceiling, then lands. `proveCandidateFall` PROVES it | proof too strict, or landing off-axis | keep the take-off (it is jump 2's landing). Landing (30704,41392)…(30704,41936) on f4800 passes slide:false. Only a near-due-south line passes: 106 of 1824 landings sampled, 63% of ±64 neighbours |
| 4 | 579 r47c39 > r49c36 | not found in any prod ledger. Declared from a 2026-08-26 trial (keeper reported 5/5); I could not tell which server that was | **landing in wall clearance**: to_fine (36340,50152) is 24 units from solid wall 421/714 at y=50176. Every check stops at y=49919 (z3744). Fails slide:true and `proveCandidateFall` too | **points are wrong** | keep the take-off (39296,47360). Landing (36544,49856) f3744, still r49c36: span 3715/6208, passes all three checks |
| 5 | 579 r15c55 > r8c55 (Brax) | **prod 2026-10-23: 11/11 landed** at (55808,7680), floor 8160, after `lift-validated` read sectors 2=800, 3=800, 4=510 | **animated sector**: the static .roo has platform sector 3 at 4224 and ledge sector 4 at 8640, which reads -4416 (uphill). With 3=800 and 4=510 applied, the declared pair passes slide:false and slide:true. Only the span gate refuses it (7168/6522; the take-off is ~950 from the platform edge) | **needs a machine-readable precondition** | `requires.sectors: {3: 800, 4: 510}` (kod serverId -> kod height), applied with `applySectorHeights`/`geometryWithSectorHeights` before proving. For the span gate too: take-off (55808,13888) r14c55 -> (55808,8064) r8c55, span 5824/6522 |
| 6 | 579 r15c56 > r8c56 (Brax) | **prod 2026-10-23: 8/8 landed** at (56832,7680)/8160, same validation | identical to #5 | same | same precondition. For the span gate: (56832,13888) r14c56 -> (56832,8000) r8c56, span 5888/6522 |
| 7 | 599 r36c16 > r38c10 (Ukgoth cliff) | **prod: 6 made, 32 missed** in movement-incident trails 2026-10-06 to 10-26. Every one took off from the stand point (15872,36352); misses land in the 3200 gully. Most misses are 10-06 to 10-13; after 10-16 it is 5 made, 1 miss. Lab jumptrials 2026-08-25: 60/68 made | Stand points only. slide:false hits solid one-sided wall 39 (the ledge lip, (13312,37888)-(17408,32768)) at (14493,36812) after 320 ms at z5872. slide:true runs down the wall and arrives. `proveCandidateFall` refuses on span (6476/4338) | **points are wrong** (none were ever given). A fine pair exists | (14208,37632) f5872 r37c14 -> (11648,39552) f3840 r39c12: drop 2032, span 3200/4338, 976 ms air, passes all three checks, 100% of ±64 neighbours. Both chords back to the old stand points walk |

## Per jump

### 1. 2502 The Archaic Hollows, r41c34 > r44c27

- **Geometry.** East plateau 8000. A ramp runs west from 8000 at x≈33280 up to **8465 at
  x=31296** (y 39424–41472), in 15-unit steps every 64. Then comes a 4800 pit, x 29184–31296,
  and then the west plateau at 8000 behind wall 21 at x=29184.
- **Declared line** (34192,41376) -> (26976,44160). Drop 0 and span 7734 against maxSpan 1415.
  The trace leaves the plateau 1100 units in, falls into the pit and lands at 4800 by 1136 ms. It
  then pushes against wall 21 until it stops at (29434,44041).
- **The operator's own note gives it away.** The one-second intermediate, KOD (1891,2589), is
  client (29232,40400). That is 48 units past wall 21, at the latitude of the ramp top. The
  operator ran up the ramp and leapt the ~2000-unit pit from its top edge.
  The declared points are the walk's start and end.
- **Fix.** from_fine (31296,40128), r40c31, floor 8465. to_fine (29120,40128), r40c29, floor 8000.
  - Margin is thin: span 2176/2344. Landings past x≈28992 still arrive in the trace, but they
    fail the span gate.
  - The chord from the old take-off up the ramp walks. The chord from the new landing to the old
    landing is refused at (27440,43288), so that leg needs the existing `HOLLOWS_OUT_POINTS`
    walk, not a straight line.
- **Live (prod).** `scratch/trek-wave.out` and `scratch/cave-walk-on.out` (2026-10-27) record five
  characters each printing all five `HOLLOWS POINT` waypoints after the crossing. Neither log has
  `ISLAND TAKEOFF REFUSED` or a `hollows_*` error.
  - `walkHollowsOut` uses `refineTakeoff: true` with `planDeclaredTakeoff`, so the live take-off was
    chosen by the planner, not read from `from_fine`.
  - `docs/m59-island-travel.md` says the refined take-off is at r40c33, on the ramp. That agrees
    with this fix.

### 2. 579 r40c33 > r40c32

- **slide:false.** Leaves 8640, crosses the 3520 trough and is refused at (32586,40224), z3520,
  by wall 376 (x=32512, 3520|7040).
- **slide:true.** Arrives in 784 ms after touching wall 436.
- **`proveCandidateFall`.** PROVED (span 1546/3876).
- **Live.** Not found in prod incident trails. The shadow lab (local server) crossed it on every
  complete Ancient node approach on 2026-09-28: 3 complete out of 5 trials.
- **Fix.** Either run the measure tool with `slide:true` (the live mover does), or move to the
  pair (33360,40464) -> (32496,40464). That pair passes everything, is 100% robust at ±64, and
  joins the old points by straight walks.

### 3. 579 r38c31 > r42c30

- **Cause.** The take-off sits 256 from solid wall 399, which is 8 units outside the radius.
  The declared aim heads 6° west of south, so the first frame enters clearance: refused at
  (30713,38461) after 48 ms.
- **slide:true.** Slides down wall 399, waits about 480 ms against wall 407 (ceiling 6080 over
  the 4800 floor) while falling, then lands exactly on (30320,42000).
- **Live.** Shadow 3/3 landings, exactly that point. No prod record.
- **Fix.** Keep the take-off, because jump 2 lands there and the two are a pair. Aim due south:
  to_fine (30704,41392) to (30704,41936) all pass slide:false, slide:true and `proveCandidateFall`.
  Then walk to (30320,42000), which is a straight chord.
- **Why this is sensitive.** Only 106 of 1824 sampled landings pass slide:false from this
  take-off. The geometry really is a sliver, so `slide:true` is the honest model here.

### 4. 579 r47c39 > r49c36

- **Cause.** to_fine (36340,50152) is 24 units north of the room's south wall: walls 421 and 714
  at y=50176, one-sided. No check can reach it. All of them stop at y=49919 (z3744). This is a
  bad point, not a strict proof.
- **Fix.** to_fine (36544,49856), still in r49c36. From the declared take-off: span 3715/6208,
  1232 ms of air, passes all three checks.
- **Live.** The entry cites a keeper-reported 5/5 on 2026-08-26 (`{jumped, asked:{49,36},
  landed:{49,36}}`), which was square-level. The fine landing was added later. I found no prod
  trail transitions from the 7952 take-off shelf to this landing. Undetermined: which server the
  2026-08-26 trial ran on.

### 5 and 6. Brax lift, 579 r15c55/r15c56 > r8c55/r8c56

- **Kod.** `kod/object/active/holder/room/monsroom/g9.kod`:
  - Platform: `SECTOR_PLATFORM = 3`, `_DN = 250`, `_UP = 800`, created `#state=SECTOR_DN`.
  - North ledge: `SECTOR_LEDGE_N = 4`, `_DN = 510`, `_UP = 540`, created `#state=SECTOR_UP`.
  - The puzzle-solved handler sends `poPlatform @MoveUp`, `poLedgeN @MoveDown`,
    `poLedgeS @MoveUp`, and `poCenterSpire @MoveUp` (sector 2 to 800). Reset reverses them.
  - So the only state with the platform raised is 3=800, 4=510, 2=800.
- **.roo.** Collision sector 72 is serverId 3, floor **4224** (264 kod, the editor's value, not
  kod's 250). Sector 159 is serverId 4, floor **8640** (540). The take-offs are in sector 3 and
  the landings in sector 4, so static geometry reads 4224 -> 8640, a 4416 climb.
  - The trace runs north across the 3200 floor and is stopped grounded at (55565,8237), z3424, by
    wall 905 (3424|8640). Lane 56 stops at (57075,8237) on wall 907.
- **With the lift applied** (`applySectorHeights`, serverId 3 -> 800x16, 4 -> 510x16):
  - The floors read 12800 -> 8160, a drop of 4640.
  - Both declared pairs **arrive** under slide:false and slide:true in 1312 ms.
  - They also arrive with 4 left at 540, and with 2=800 added.
  - `proveCandidateFall` still refuses them on span alone, 7168 against 6522.
- **Live (prod 2026-10-23, `substrate/brax-attempts/`).**
  - 19 `lift-validated` events, each observing `{2:800, 3:800, 4:510, ...}`.
  - 19 north landings, all `landing-observation` with expectedFloor = actualFloor = 8160:
    11 in lane 55 and 8 in lane 56.
  - The entry jumps landed on floor 4000, which is sector 3 at 250 and confirms kod over the .roo.
  - The `failure` events (17) are road, rail-follower and detour failures. None of them is a
    missed jump.
- **Fix.** Add a machine-readable precondition, for example
  `"requires": {"running": true, "timed_fall": true, "sectors": {"3": 800, "4": 510}}`, in kod
  serverId and kod height. `geometryWithSectorHeights` already takes exactly that shape.
  - Every proof (measure, `proveCandidateFall`, the planner) applies it before tracing.
  - The live executor keeps checking it, as `m59-brax.mjs` does today.
  - If the span gate is to accept the declaration, also move the take-off to the platform's north
    edge, r14 at y=13888 (pairs in the table).
  - The entries #14/#16 (`must be down (250)`) want the same treatment: `{"3": 250}`.

### 7. 599 Ukgoth cliff r36c16 > r38c10

- **Geometry.**
  - Take-off shelf: 5872, with a 6080 strip to its south-east.
  - Wall 39 is a **solid one-sided wall** along its west lip, (17408,32768) -> (13312,37888). Past
    it lies the 4576 band.
  - Below and west: 3712 (north of y=38016) and the 3840 landing shelf (x ≤ 12288, y ≥ 38016).
  - The 3200 gully lies at x 12288–14600, y ≥ 38016.
  - "The take-off ledge runs out around 2.5 squares along this line" is wall 39: you cannot leave
    the shelf westward. You run south-west along the lip until it ends at (13312,37888) and leap
    over the gully corner.
- **Stand points.** slide:false meets wall 39 at (14493,36812) after 320 ms, still at 5872.
  slide:true slides the full length of the wall, runs off its end and lands on (9728,38400) in
  1520 ms. `proveCandidateFall` refuses on span, 6476 against 4338.
- **A fine pair the proof accepts.** (14208,37632) f5872 r37c14 -> (11648,39552) f3840 r39c12:
  - drop 2032, span 3200/4338, 976 ms of air;
  - passes slide:false, slide:true and `proveCandidateFall`, wire-rounded included;
  - 100% of ±64 neighbours pass;
  - both chords walk: from the old take-off stand point (15872,36352), and on to the old landing
    (9728,38400).
- **A shorter alternative** takes off from the 6080 strip: (13824,38080) r38c14 -> (11648,38656),
  span 2251/4546.
- The proposed pair is outside the declared squares. Either re-key the entry to r37c14 > r39c12,
  or keep the squares as the index and carry fine points outside them; check that
  `planDeclaredTakeoff` tolerates the second option.
- **Live, prod** (`history/prod/movement-incidents-*.jsonl` trails; consecutive 1 s samples in 599
  from the take-off shelf to the 3840 shelf (made) or the 3200 gully (missed), ≤ 5 s apart):
  - 6 made, 32 missed, 2026-10-06 to 10-26.
  - Every sample takes off from exactly (15872,36352), which is the stand point, and arrives about
    1 s later.
  - Misses land at x 12560–13296, y 38320–38544, floor 3200: short, in the gully.
  - These trails exist only for journeys that went on to log an incident, so this is a biased
    sample, not a rate. The trend is still visible: 31 of the 32 misses are on or before 10-13,
    and from 10-16 there are 5 made to 1 miss.
- **Live, lab.** `substrate/jumptrials.jsonl`, 2026-08-25, `m59-jumptrial` (loopback-only, DM
  placement): 60 of 68 made. All 8 misses landed in 38,13 at floor 3200, three with a troll on
  the line.
- **The fine pair has never been flown live.** It shortens the airborne part, from a 1520 ms
  sliding run to 976 ms, and lands 640 units deeper on the shelf than the gully edge.

## What I could not determine

- Which server the 2026-08-26 trial of #4 (579 r47c39) ran on, and whether any character has
  flown it since. Prod movement-incident trails (from 2026-10-04) show no transitions from its
  take-off shelf.
- Any prod record for #2 and #3. The only executions found are the shadow-lab node trials of
  2026-09-28.
- A success *rate* for 599 on prod. The tactics ledger records declared jumps only as
  pre-jump `attempted:false` rows, and trails are kept only for incident journeys. A per-jump
  outcome row (take-off point, landing point and floor, airborne ms) is the missing evidence.
- Whether the live executor's final packet for 599 is the slid trace's end point. `unclipped`
  passes it only when that end point equals the aim, and the trail shows the stand point
  followed by the landing about 1 s later, which is consistent with that.
- None of the proposed fine points has been flown. They are offline proofs on the committed map.

## Applied, 2026-10-31 (branch `fix/falljumps`)

The operator approved option 1. What changed:

- **`substrate/m59-falljumps.json`.** Every changed entry keeps its fields and gains a dated note line.
  - #1 2502 is now r40c33 > r40c29: (33408,40128) to (29120,40128).
  - #4 579 r47c39 lands at (36544,49856).
  - #7 599 is re-keyed to r37c14 > r39c12: (14208,37632) to (11648,39552).
  - #5 and #6 Brax north take off at the platform edge, y=13888 (r14), and land at y=8064 / 8000. They carry `requires.sectors {3:800, 4:510}`.
  - The Brax entries r32 > r25 carry `requires.sectors {3:250}`.
  - #2 and #3 keep their points.
- **One proof.** `m59-declared-jump.mjs` (`proveDeclaredJump`, `LIVE_FALL_TRACE`, `geometryForDeclaration`) is now the check `finenav-measure --jumps` runs.
- **Span gate.** `proveCandidateFall` measures the air (`airPhases`), not the chord.
- **Live precondition.** Session.step checks `requires.sectors` against `client.room.sectorHeights` and refuses with `jump_precondition_unmet` or `jump_precondition_unknown`. Both are terminal. The keeper and broker `jump` verbs name the precondition.
- **Outcome rows.** Each declared-jump attempt writes one row to `history/<fleet>/jump-outcomes-*.jsonl` (`m59-jump-outcomes.mjs`).

All 18 declarations now prove: `node tools/m59-declared-jump.mjs`.

**Different from the audit's proposal: the Hollows take-off.** The audit proposed the ramp top (31296,40128), floor 8465, as `from_fine`. The declaration uses the ramp foot instead, (33408,40128), floor 8000, on the approach shelf. Two reasons:

- `followDeclaredApproach` fences the approach at `floor(from_fine) - 384`, and `planDeclaredTakeoff` requires the take-off within 64 of that same floor. A ramp-top `from_fine` would put every staging pose on the 8000 plateau below the fence.
- With the air-span gate, the run up the ramp is not air. The leap off the lip measures 2130 against 2351, so the run-up take-off proves on its own terms.

**Rebake.** `m59-routebake --rooms 2502,579,599` changed those three rooms and no others; 261 rooms are byte-identical. A control rebake with the old jump table showed which changes come from the jumps. Only 599's `routes` and `pivots` do. The rest is drift since the table was last baked, from another checkout:
- 579: `main_region` 43 > 81, 1572 > 1727 squares.
- All three rooms: `anchors` gain `reached_by`.
- 2502: `routes` and `pivots`.

The committed table takes only the jump's change: 599 `routes`/`pivots` from the new bake, everything else as before, top-level metadata unchanged. One consequence needs review before a deploy. 599's `1,66>1,27` (east door to north door) now runs along the north side instead of down through r18c58 to the old take-off. That is a different road through troll country, not just a different last hop.
