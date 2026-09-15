# What the source says about the seven stones

**From:** m59-research, reading `C:\code\Meridian59` at `1fb1f514`
**Date:** 2026-09-10
**For:** whoever picks up `/node-runner` next

---

## Bottom line

**One of the eight stones in the book is not a terrain problem at all**, and no amount of
movement work will close it. Of the four that are genuinely unsolved terrain, the mover's model
of the client is wrong in one structural way and three arithmetic ways — and the structural one
is why `m59-falljumps.json` has to be hand-written in the first place.

| | what it actually is |
|---|---|
| **1006 Mausoleum** | a **two-lever puzzle with a rising column**. The node platform sits at floor **500** and drops to **105** when the last monster in the final chamber dies. It is also the **guest** node. Not a jump at any size — §5. |
| **27, 45, 515, 589** | genuinely terrain, and genuinely unsolved. §1-§4 are for these. |
| **39, 579, 750** | `BASELINE.md` already has these right: the map is not the obstacle. |

Separately: there are **thirteen mana-node bits in the kod, not seven**, and **five nodes are not
in the book at all** — including one in **room 599**, which you currently treat only as a
`KNOWN_TRAP`, that exists for **5 real minutes in every 2 hours**. §6 and §7.

---

## 1. The structural defect: the flood's state is a square, and a jump's state is not

`moverStepLands` → `_traceMoverStep` (`tools/m59-roo.mjs:2471`) calls

```js
this.traceFineMoveClient(fromX, fromY, toX, toY, { slide: true })
```

with **no `motionZ`**, and `fall` defaults to `false` (`m59-roo.mjs:1295`). So every step in the
flood is evaluated as if the body were **standing still on the floor of the from-square.**
`carriedMotionZ` is seeded from that square's floor and is discarded when the step returns.

A drop-jump is not a property of one step. It is a property of a *sequence*: step 1 leaves the
ledge, steps 2..N happen with the height step 1 left with. **A memoryless predicate cannot
represent it, however faithful each individual step is** — and `canCrossWallAt`
(`m59-roo.mjs:3921`) *is* faithful; it is a correct port of `IntersectNode`, wading depth and
null-sidedef short-circuit included.

That is the whole explanation of why every affordance has to be declared by hand, and why
`BASELINE.md` reads "we have been offering the one shape the terrain never has". The file is
not missing a `kind`. **The flood is missing a dimension.**

> **The fix is a state-space change, not a format change.** Flood over `(cell, carried z)`
> instead of `(cell)`. Carried z is cheap to bound: it is a monotone non-increasing function of
> horizontal distance since take-off (§2), so `(cell, take-off height)` is enough, and in
> practice `(cell, airborne budget in client units)` bucketed to ~64 units is enough. A cell is
> re-expanded only when reached with a *higher* carried z than before, which makes the flood
> terminate for the same reason Dijkstra does.

This also dissolves the "level jump cannot be written down" problem in `BASELINE.md`. A level
jump is not a new declaration kind — it is an ordinary traversal that the flood cannot see
because it forgets the body is in the air.

---

## 2. The physics, so you can compute a jump instead of declaring it

All four constants, from source:

| | value | site |
|---|---|---|
| initial fall speed | `FALL_VELOCITY_0 = -FINENESS*2/3` = **682.67 u/s** | `clientd3d/move.h:17` |
| gravity | `GRAVITY_ACCELERATION = -5*FINENESS` = **5120 u/s²** | `clientd3d/moveobj.h:15` |
| run speed | `2 * MOVEUNITS` per `MOVE_DELAY` = 512 u / 100 ms = **5120 u/s = 5 squares/s** | `move.c:184`, `move.c:49`, `draw3d.h:53` |
| walk speed | `MOVEUNITS` per `MOVE_DELAY` = **2560 u/s = 2.5 squares/s** | `move.c:187` |

Integrated at `moveobj.c:295,316`, so the drop after `t` seconds is

```
drop(t) = 682.67·t + 2560·t²        (client units)
```

**The reach table.** Horizontal distance a running body covers before it has fallen a given
amount:

| drop (client u) | drop (sq) | flight (s) | **run reach (sq)** |
|---:|---:|---:|---:|
| 384 | 0.38 | 0.276 | **1.38** |
| 1024 | 1.00 | 0.513 | **2.57** |
| 1600 | 1.56 | 0.668 | **3.34** |
| 2048 | 2.00 | 0.771 | **3.85** |
| 3072 | 3.00 | 0.970 | **4.85** |
| 3648 | 3.56 | 1.068 | **5.34** |
| 4640 | 4.53 | 1.220 | **6.10** |
| 6144 | 6.00 | 1.422 | **7.11** |

and its inverse, which is the one the planner wants:

| run distance (sq) | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **fallen (client u)** | 239 | 683 | 1331 | 2185 | 3243 | 4506 | 7646 | 11605 |

**The landing rule.** Leaving a floor at `Zt` and running `D` squares, your tested height is
`Zt - drop(D/5)`, and the client accepts any landing whose wall `z1` satisfies

```
z1 - depth(far sector) - (Zt - drop(D/5))  <=  384
```

so the landing floor may be up to `384 - drop(D/5)` **ABOVE** the take-off. Concretely:

- **1 square: you may land up to +145 above the take-off.**
- **1.38 squares: exactly level.**
- Beyond that, below, by the table.

---

## 3. Three arithmetic errors in `fallTargets` (`m59-roo.mjs:2357`)

**a. "DOWNHILL ONLY" is off by 384 units.** `if (landFloor > startFloor) continue;` is one `>`
away from correct. The client's bound is `landFloor <= startFloor + MAX_STEP_HEIGHT -
drop(distance)`. Every level jump and every short uphill jump is excluded by that line, and
`BASELINE.md` says every remaining stone is *level or above*. This single condition is why the
detector has never offered a candidate for room 27.

**b. `FALL_MAX_SQUARES = 3` (`m59-roo.mjs:126`) is roughly half the real range.** From a
3.5-square drop a running body crosses 5.34 squares; from 6 squares, 7.11. Sentinel's gap is 9
and Mausoleum's is 10 — but Peak's is 5 and Badlands' is 3, both inside range and both outside
the search.

**SCOPE, added 2026-09-10 after review.** (a) and (b) are defects in `fallTargets` and in the
flood. They are **not** defects in `m59-jumpfinder.mjs`, which already has the physics exactly
right — `airTime`, `reachFor`, `fallenBy`, and a per-sample carried-z test at
`m59-jumpfinder.mjs:240-241` that is the (cell, carried z) rule of §1 applied along an arc.
Anyone rewriting the flood should read jumpfinder first; it is much closer to the answer than
`fallTargets` is. Its one real defect is §3d.

**d. `jumpfinder`'s level-hop cap is a constant where the client has a curve**
(`m59-jumpfinder.mjs:226-228`). The client's rule is a single expression — a landing is legal
when `fallenBy(t) <= drop + MAX_STEP_HEIGHT`, so the true maximum span is
`reachFor(drop + 384)`. Measured against that:

| drop (u) | 0 | 96 | 192 | 288 | 384 | 512 | 1024 | 2048 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| jumpfinder cap (u) | 1536 | 1536 | 1536 | 1536 | 1536 | 2219 | 3139 | 4459 |
| client true cap (u) | 1415 | 1637 | 1840 | 2028 | 2204 | 2422 | 3175 | 4354 |
| error (squares) | **+0.12** | -0.10 | -0.30 | -0.48 | **-0.65** | -0.20 | -0.04 | +0.10 |

So the `F * 1.5` constant is permissive by 0.12 squares at dead level — the known bit — but
**restrictive by up to 0.65 squares at the top of the same branch**, which is the direction
that *loses* candidates, and the `+ F/2` fudge in the `else` branch is restrictive across the
mid range too. Both collapse to one exact line:

```js
if (span > reachFor(drop + MAX_STEP_HEIGHT)) return false;
```

which removes both magic constants and is correct at every drop.

**c. Straight rays with `break` at the nearest landing.** `fallTargets` walks the 8 `DIRS` and
takes the first standable square in each. But the client lets you **steer the whole time you are
airborne** — `UserMovePlayer` runs every frame regardless of vertical state — so the reachable
set from a take-off is a **2-D region**, not 8 rays, and the nearest landing on a ray is usually
the worst one. Replacing `fallTargets` with the §1 flood makes this problem disappear rather
than needing its own fix.

---

## 4. One over-strict conjunct in the microstep trace

`m59-roo.mjs:1112-1113`:

```js
const crossable = canCrossWallAt(wall, to.x, to.y, zMin, side, { playerHeight })
  && canCrossWallAt(wall, to.x, to.y, zMax, side, { playerHeight });
```

The client evaluates **one** z, and it is the maximum:

```c
z = std::max(player_obj->motion.z, GetFloorBase(last_x, last_y));   // move.c:286
...
z = std::max(z, player_obj->motion.z);                              // move.c:371
```

For the step-up gate, larger `z` is *more* permissive, so requiring crossability at `zMin` as
well refuses climbs the stock client allows. The interval is a harness invention for an
uncertainty the client does not have — `motion.z` is a single number there. Use `zMax` for the
step gate. (Keeping `zMax` for the headroom gate is already right, and already what it does.)

The comment at `m59-roo.mjs:1450` — *"The stock client checks height when you cross BETWEEN
SECTORS, and a slope lies inside one sector"* — is the thing to correct in your heads. **The
client checks height at a WALL whose facing sidedef has a below bitmap, and nowhere else.**
That is why narrowing `enforceStepHeight` to a sector transition "never fires": sector identity
is not the predicate. `canCrossWallAt` already has it exactly right; the per-microstep floor
comparison behind `enforceStepHeight` is a second, blunter rule that the client does not have,
and it is why enabling it breaks legitimate slopes.

Two consequences worth writing into the roomview legend:

- **A wall with no below texture has no step limit at all.** `move.c:549` short-circuits on
  `sidedef->below_bmap == NULL`. An untextured riser is climbable at any height.
- **Wading depth on the FAR side is subtracted from the step.** `sector_depths[] = {0, 204,
  409, 614}` (`draw3d.c:80`), so stepping into a very deep sector permits a **998-unit** rise,
  2.6× the documented cap. You already decode this in `canCrossWallAt`; nothing upstream of it
  reasons about it.

---

## 5. The Mausoleum (1006) is a lever puzzle and the column comes to you

`kod/object/active/holder/room/monsroom/guest6.kod`:

- Two `GuestLever`s at **(27,4)** and **(27,9)** — `CreateLevers`, line 286-297.
- `LeverChanged` (line 381): one lever raises the door sector's ceiling to **128**; two levers
  raise it to **172** and start `FightTimer`.
- `CheckAllDeadMonsters` (line 501): when the final chamber holds **zero monsters and at least
  one player**, `DoColumnDown` fires and the node sectors drop:

```
SECTOR_NODE1: floor 500 -> 105     SECTOR_NODE2: floor 519 -> 124     (speed 32)
```

So the node is on a column that is **~500 units up until you clear the room**, and the reset
path (line 484) puts it back. The `.roo` on disk holds one of those states, and the harness has
been measuring a gap to a platform that is not supposed to be reachable in that state.

**This is not a movement bug and no jump will ever close it.** `SetSector` is documented in
`room.kod:2478` as *"Call this to change the height of a sector (affects clients only, not move
grid)"* — i.e. live floor heights are room state replayed from `plSector_changes`
(`room.kod:1868, 2500, 4059`), not a property of the file. You already have the machinery:
`applySectorHeights` (`m59-roo.mjs:4315`) plus a per-state baked mask. It is wired for doors via
`m59-doorbake.mjs`; sectors 4 and 5 of room 1006 need the same two bakes.

Also: **this is the guest node.** `blakston.khd:2278` — *"Guest node is normally not attainable
except by guests."* `TryActivate` itself has no guest check, so a normal character who gets into
the room can meld it, but "no route to the room from Tos at all" is the design, not a gap in the
atlas.

---

## 6. Nodes that are not always there

`NodeAppear` / `NodeDisappear` exist, and five nodes use them:

| node | room | condition |
|---|---|---|
| `NODE_I9` | **599 Ukgoth** | `i9.kod:181` — appears at **(27,61) fine (48,40)** when `Send(SYS,@GetHour) = 0`, guarded by three `StoneTroll`s spawned at the same moment; `NodeDisappear` at hour 1 |
| `NODE_Q` | 47 Canyon2 | `canyon2.kod:98` — appears at (57,45) |
| `NODE_FAERIE` | 532 FeyForest C2 | `c2.kod:137,145` — appears at (23,30), karma-gated |
| `NODE_AVAR` | 2154 KCForest KE4 | `ke4.kod:262,276` — good/evil variants on a `NODE_APPEAR_TIME` timer |
| `NODE_CORPSENODE` | Underworld | `uworld.kod:426` — at (16,16); a `Portal` subclass, not a `ManaNode` |

The trigger chain is `NewHour` → `NewGameHour` (`system.kod:1096`) → `for i in plRooms { Send(i,@RecalcLightAndWeather) }` (`system.kod:3646-3648`) → `i9.kod:164`. (The `%Send(self,@RecalcLightAndWeather)` commented out at `system.kod:1101` is redundant, not a break — `NewGameHour` does it.)

**A game hour is 5 real minutes** (`blakserv/config.c:136-137`, `KodPeriod = 5`; the 1997 manual's
50 is long obsolete). So room 599's node is present for **5 minutes in every 2 hours**, and a run
that finds nothing there has measured the clock, not the map.

**Node state gates the meld independently of position.** `mananode.kod:167` — `piState =
NODE_DEAD` refuses with `ManaNode_failed_meld` *before* the range test. States are
`NODE_NORMAL` / `NODE_CURSED` / `NODE_DEAD` (`mananode.kod:245-259`), and `NodeAttack`
(a `UtilityFunctions` class) drives them. **A dead node is indistinguishable from a movement
failure unless you read the message.**

But you do not have to try the meld to find out: the node's state is on the wire as its
**animation** (`mananode.kod:243-262`).

| `piState` | what the client is sent |
|---|---|
| `NODE_NORMAL` | `ANIMATE_CYCLE`, period 150 ms, groups **1-5** |
| `NODE_CURSED` | `ANIMATE_CYCLE`, period 250 ms, groups **6-7** |
| `NODE_DEAD` | `ANIMATE_NONE`, group **8** |

A static group-8 node in the room contents is a dead node, and no amount of walking will meld
it. That is a one-line addition to whatever reads `BP_ROOM_CONTENTS`, and it turns a class of
silent failures into a printed reason.

---

## 7. Reference: every node, from source

**CONFIRMATORY, NOT NEW — corrected 2026-09-10 after review.** `tools/fleetscripts/mana-node.mjs`
already holds all eight squares and already carries rooms 47 and 599 with the hour-0 note, and
`tools/m59-stones.mjs` already builds the census from the `blakston.khd` enum (so it already
says thirteen, already handles the `FeyNode`/`AvarNode` subclasses and deferred placement, and
`--check` fails a drifted list). Treat this table as an independent read of the source that
agrees with them, not as news. **Do not spend a run re-deriving it.**

Thirteen bits at `kod/include/blakston.khd:2267-2280`. The eight in the book are all placed
statically at construction with `NewHold`, so these squares are exact and permanent:

| node bit | room | **node square** | fine | site |
|---|---:|---|---|---|
| `NODE_VICTORIA` | **39** | **13, 46** | 0,0 | `castle1b.kod:61` |
| `NODE_G9` (Ancient) | **579** | **52, 30** | 0,48 | `g9.kod:255` |
| `NODE_H9` (Sentinel) | **589** | **45, 32** | — | `h9.kod:133` |
| `NODE_ICECAVE1` (Ice) | **750** | **25, 23** | 32,32 | `icecave1.kod:138` |
| `NODE_BADLANDS` | **45** | **63, 46** | — | `badland1.kod:61` |
| `NODE_ORCCAVES` (Icky Cave) | **27** | **23, 53** | — | `cave2.kod:125` |
| `NODE_A5` (Peak) | **515** | **20, 17** | 0,0 | `a5.kod:90` |
| `NODE_GUEST` (Mausoleum) | **1006** | **35, 5** | 0,0 | `guest6.kod:532` |
| `NODE_I9` | 599 | 27, 61 (hour 0 only) | 48,40 | `i9.kod:184` |
| `NODE_Q` | 47 | 57, 45 | — | `canyon2.kod:98` |
| `NODE_FAERIE` | 532 | 23, 30 | — | `c2.kod:137` |
| `NODE_AVAR` | 2154 | — | — | `ke4.kod:262` |
| `NODE_CORPSENODE` | Underworld | 16, 16 | 32,32 | `uworld.kod:426` |

The meld box is confirmed: `MANANODE_RANGE = 3` (`mananode.kod:17`) with
`abs(dRow) < 3 AND abs(dCol) < 3` (`mananode.kod:177`) — ±2 per axis, 5×5, exactly as
`SKILL.md` says. `TryActivate` also requires `poOwner = Send(who,@GetOwner)`, i.e. you and the
node must be held by the same room.

Rooms **45** and **515** have no levers, no timers and no `NodeAppear` — `badland1.kod` has
three handlers and `a5.kod` seven, none of them geometry. Those two are pure terrain and belong
to §1-§4.

---

## 8. Added 2026-09-10: two questions the first pass left open

### 8a. `#height=` is KOD units, and the gate is a step at a wall, not a height

Settled from source. `SetSector`'s `#height=` goes onto the wire unconverted
(`user.kod:3459`, `AddPacket(...,2,height,...)`), and the client converts on receipt:

```c
SectorAdjustHeight(&current_room, s, type, HeightKodToClient(height));   // roomanim.c:446
```

`HeightKodToClient` is `<< 4` (`drawdefs.h:60`), so **the kod value is in KOD height units,
64 to a square vertically, and the client multiplies by 16.** Comparing `#height=` against
`MAX_STEP_HEIGHT` (384 *client* units) is the 16x error; the kod-side threshold is **24**.

But the units fix alone is the wrong shape, which is why `lo < 24` is false for every door in
the world. `SectorAdjustHeight` sets `s->floor_height = height` **absolutely** and then calls
`SetWallHeights(wall)` for every wall where `pos_sector == s || neg_sector == s`
(`roomanim.c:647-654`). That is what recomputes `wall->z1` — the exact value the step predicate
reads. **So a moving floor gates movement iff, after the move, some wall bounding it has
`z1 - z > MAX_STEP_HEIGHT`.** An absolute floor height cannot answer that: a platform at 500
is not a barrier, the 395-unit *step between it and the ground beside it* is. `gateRisk` wants
the moved sector's floor compared against its **neighbours'**, not against a constant.

One more thing that falls out of the same function: `r->motion.z = s->floor_height` for every
object standing in a lifting floor sector (`roomanim.c:666`). **A body in the sector rides it**,
and is moved vertically in one step rather than animated. That is how you leave room 1006's
column once it is down, and it is also a free lift wherever a floor rises under you.

### 8b. Room 27 has SIX inbound edges, not one, and four are region exits

The arrival square is what `reachableFrom` must be seeded with, so here is the exhaustive set
for `RID_CAVE2`. The node is at **(23,53)**, so the meld box is rows 21-25, cols 51-55.

| from | mechanism | arrival square |
|---|---|---|
| Cave3 | `plExits` door at (75,34) — `cave3.kod:79` | **(19,30)** |
| Orccave1 | `plEdge_Exits`, `LEAVE_EAST` — `orccave1.kod:73` | **(11,1)** |
| Forest2 | region: `new_row < 19 AND new_col < 7` — `forest2.kod:102` | **(55,35)**, angle N |
| H7 | region: `new_row < 18 AND new_col < 7 AND new_row > 14` — `h7.kod:77` | **(57,46)**, angle N |
| Nest1 | region: `new_row = 26 AND new_col = 14` — `nest1.kod:117` | **(53,14)**, fine (16,16) |
| Nest1 | region: `new_row = 2 AND new_col = 19` — `nest1.kod:129` | **(50,25)** |

**CORRECTED 2026-09-10.** The first pass of this table said five and missed `nest1.kod:129`.
The grep had returned two hits in `nest1.kod` and only the first was followed — the search was
right and the reading stopped early, which is the failure this project's own rule names. The
list above is now every `RID_CAVE2` reference in `kod/`, classified: four region exits
(`forest2:103`, `h7:78`, `nest1:118`, `nest1:130`), one `plExits` (`cave3:79`), one
`plEdge_Exits` (`orccave1:73`), and four non-arrivals — `h7:69` is a `plYell_Zone`, `cave2:36`
is the room's own `piRoom_num`, `system.kod:2219` creates the room, and `chalice.kod:75,159`
are `poOwner` tests for a separate guarded item at (23,11) that is not node-related.

Only Cave3's `(19,30)` is anywhere near the stone; the other five land in the room's south. So
a directed flood seeded from `(19,30)` alone is the one that produces the BASELINE figure, and
the three region arrivals have probably never been seeded at all.

**And the arrival square is a HINT, not a guarantee.** All three region exits go through
`UtilGoNearSquare` (`kod/util.kod:20`), which is an expanding **Chebyshev ring search** from the
named square — radius 0 first, then 1, then 2 — taking the first square where `UtilGoToSquare`
succeeds, clamped to the room bounds, with `max_distance` defaulting to 50000. Normally you land
on the hint. With something standing there you do not, and nothing tells you. A quirk worth
knowing: on the ring's left/right edges the recursive call omits `new_angle`, `fine_row`,
`fine_col` and `do_move`, so a displaced body lands at square centre (32,32) with its old angle,
while one placed on the ring's top/bottom row keeps the caller's fine offsets.

## 9. Resolved 2026-09-10, after two rounds with the node-tour session

**The frame falls before it moves.** `GameIdle` (`statgame.c:388-389`) runs `AnimationTimerProc`
before `HandleKeys`, so `MoveSingleVertically` (`animate.c:128` -> `moveobj.c:195,254`) has
already dropped `motion.z` by the time `UserMovePlayer` reads
`z = max(motion.z, GetFloorBase(last))` at `move.c:286`. `UserMovePlayer` never writes
`motion.z` — only `dest_z` and `v_z` (`move.c:408-421`). So **every collision sub-step in a frame
shares one z**, and the step gate is a per-frame staircase rather than a curve. A simulator that
moves first and falls second flatters every candidate by about a frame.

**Horizontal reach is quantised, and finely enough to matter.** `num_steps = max(1, min(20,
200*dt/1000))` (`move.c:266`), and `xinc = dx / num_steps` (`move.c:268`) — integer division,
so the loop accumulates `num_steps * xinc` and **loses the remainder every frame**:

| dt (ms) | 8 | 16 | 33 | 66 | 100 | 200 |
|---|---:|---:|---:|---:|---:|---:|
| sub-steps | 1 | 3 | 6 | 13 | 20 | 20 |
| per-frame loss | 0 | 0 | 0 | 12 | 12 | 12 |

It divides evenly at fine rates and costs 2.3-3.6% of ground speed at coarse ones. Credit to the
node-tour session for that one; it is a real effect and my first model missed it.

**Consequence for any thin candidate.** The reach bracket is one frame of horizontal wide, which
is 25-40 client units across the usable range. **Jump 3 of the room 27 route (drop 384, span
2202) is inside that bracket at every frame rate**, so the arithmetic cannot decide it and a body
must. Use the closed form (§2) as the planner's gate — being the conservative model is the right
property for something that proposes routes — and treat any discrete simulation as a reporter
that prints the bracket, not a gate.

**Two claims withdrawn in the course of getting here**, recorded so nobody rediscovers them:

- Mine: "`gravityAdjust` makes jump range frame-rate dependent." It does the opposite (§ above).
- Theirs: "the closed form is a conservative lower bound up to a drop of ~3517." Measured with
  the ordering right, there is **no clean boundary** — the closed form sits below the bracket at
  drops 0/1024/2048, inside it at 384/3072/4096 and above it at 6144/10240. Interleaved, not
  crossover.

**What survives, and it is the part that mattered:** `F * 1.5` missed jump 3 by **666 units** —
0.65 squares, the exact column §3d predicts. Room 27 having any candidate at all is downstream of
the one-line cap fix, and that stands whatever a body finds. The retraction is about the margin,
not the repair.

## 10. Room 515 measured, 2026-09-10 — and it is a DESCENT

Parsed `a5.roo` (v13) through `tools/m59-roo.mjs` itself, so the format handling is the
harness's own.

**No free climb exists** — the conclusion holds, but **the method below is wrong; see §11.**
It counts `w.z1 - w.z0`, the lower-wall texture band, where the step a body takes is
`w.z1 - depth - (the floor it stands on)`. Re-measured correctly the answer for 515 is still
zero, so this section's conclusion was right by luck. Do not copy the metric.

Of 1418 wall-sides in room 515 rising more than 384, 1353 carry a
below texture and 65 do not — and every one of those 65 is `WF_PASSABLE = false`, so it blocks
regardless. **Ungated *and* passable risers over 384: zero.** So there is no untextured riser the
flood is failing to climb here, and §4 is not this room's problem.

**A legal staircase exists, made of maximum-height treads.** Flooding upward over sectors from
everything at or below 8896, the heights reached are:

```
9216  9376  9600  9984  10368  10656  10752  11136  11520  11904  12288
gaps:  160   224   384    384    288     96    384    384    384    384
```

Six of ten rises are **exactly 384**, legal only because `move.c:551` compares `<=`. **A strict
`<` anywhere in the step-height chain deletes that whole flight** and makes the room's high
ground read as unreachable terrain. `canCrossWallAt` and the `enforceStepHeight` block both have
the inclusivity right; the bake, fineroute, jumpfinder and gap have not been audited for it.

**The stone's shelf is off that staircase, and the staircase goes past it.** 10848 is not
reached. But 11136, 11520, 11904 and 12288 are — the top is **1440 units ABOVE the stone**. So
515 is very likely a descent: get onto the high flight, then fall-jump down onto 10848, which is
well inside a 6-jump search. 10656 and 10752 are also reachable, and 10752 is only 96 below the
stone shelf — a trivial step if the two were adjacent in space, which they are not.

**What this model is.** Sector adjacency using `floorHeight`, `WF_PASSABLE`, the below-texture
gate and wading depth. It ignores player radius, the coarse grid, headroom and slope, and seeds
from every low sector rather than from an arrival — so it is an **optimistic upper bound**. Read
it accordingly: *"10848 is not reached"* is robust, because an optimistic model that still cannot
get there is strong evidence; *"12288 is reachable"* is a **lead**, and the 384 treads are exactly
where an optimistic model would differ from a correct one. Confirm with a fine flood before
acting. If the staircase does not survive that confirmation, **the difference between the two
floods on those 384 treads is the bug**, and it is worth more than the stone.

## 11. Room 589 measured — RETRACTED, and what replaced it

**The measurement in this section was wrong twice and has been withdrawn.** Recorded rather than
deleted, because the two mistakes are both ones this file warns about.

**Mistake 1, the metric.** I counted walls where `w.z1 - w.z0` exceeded 384. That is the height
of the **lower-wall texture band**, not the step. The step a body takes is
`w.z1 - depth - (the floor it is standing on)`. Re-measured with the right quantity:

| | ungated + passable, real step over 384 |
|---|---:|
| room 515 | **0** |
| room 589 | **0** |
| room 27 | 1 |

So 589 has **zero** free climbs, not the eight this section claimed, and "one lands 224 units
below the stone" was an artifact. 515's zero was right by luck — correct answer, wrong
instrument.

**Mistake 2, the split square.** The heights were sector floors sampled at square centres. At the
points a body actually stands (`standPoint` + `floorBaseAtClient`) the headline face reads
**720 -> 1072**, a 352 rise — legal, ordinary ground. Two of the eight are level ground the mover
already crosses. This is the trap the skill's own "measuring the ground" section names, hit
squarely.

**A matching artifact on the other side.** The node-tour session's "37 ungated + passable +
over-cap walls in 515, all at the node's floor" reproduces exactly — 258 ungated sidedefs, 37,
32 of them at z1 = 10848 — **but only when tested at `z = 0`**, which is `canCrossWallAt`'s
default parameter. At z=0 "over-cap" means `z1 > 384`, true of nearly any elevated wall. Tested
at the near sector's floor the count is **0**. Both of us produced a free-climb finding from an
instrument rather than from the world, in the same exchange, from opposite directions.

**What does survive, and it is the real result.** The harness has **two height rules where the
game has one**. `canCrossWallAt` mirrors `move.c:551` correctly, including the no-below-texture
short-circuit. `enforceStepHeight` (`m59-roo.mjs:1457`) is a second, floor-to-floor test with no
knowledge of sidedefs, it is **on by default**, and it overrules the correct one:

| room | adjacent lattice pairs rising past the cap | accepted |
|---|---:|---:|
| 589 | 1892 | **0** |
| 515 | 9469 | **0** |
| 27 | 588 | **0** |

Zero of 11,949, every refusal `step_too_high` — and a twenty-line comment beginning "WHY IT IS
OFF" describing costs that no longer exist (`m59-collision-test` 404/404 and
`m59-impossible-test` 132/132 with it on).

**The cost is still undemonstrated, and that is the open question.** No free climb has been shown
in any of the four rooms. If all 11,949 refused pairs cross **textured** risers, refusing them is
correct and the blunt rule is latent rather than active here. The one measurement that decides
it: *of the refused pairs, how many cross a wall whose facing sidedef has no below texture?*
Zero means these stones are separated for some other reason; non-zero means case (b) with
coordinates.

**The fix is not the flag.** Turning it off re-opens every cliff it closes. The fix is the one its
surviving paragraph names: find the crossing line between the two leaves and gate on the sidedef
the way `canCrossWallAt` already does, after which the blunt test can be deleted rather than
narrowed. That narrowing it to a sector change "never fires" is the clue — the resolver's notion
of a sector transition is what needs fixing first.

### The finding that outlives the stones

Four rooms, four different shapes, and **not one of them is the declared fall the file was built
for**:

| room | shape | right instrument |
|---|---|---|
| 27 | level gap, no vertical component | a jump — and the cap fix found one |
| 45 | stone **3230 below** reachable ground | descent; jumping is exactly right |
| 515 | no free climb; staircase not boardable from its one arrival | genuinely separated |
| 589 | no free climb either; three arrivals, not the one BASELINE records | unresolved |

and possibly a fifth: **one of the four may be our own second height rule** — pending the
measurement above, because today there is a demonstrated bug and an undemonstrated cost.

## 12. Closed: the second height rule costs one wall, and it is not load-bearing

The measurement §11 asked for, run by the node-tour session across four rooms. Of the adjacent
lattice pairs `enforceStepHeight` refuses, how many cross a wall that would *not* have gated
them:

| room | refused | textured riser | **ungated** | wall-less |
|---|---:|---:|---:|---:|
| 515 | 991 | 886 | **0** | 0 |
| 589 | 470 | 180 | **0** | 7 |
| 27 | 15 | 15 | **0** | 0 |
| **45** | 2885 | 2789 | **7** | 0 |

**Case (b) exists, once, with coordinates.** All seven are the same wall in room 45:
`(47616,56832)-(48128,58368)`, floor 2464 -> 2912, a 448-unit rise past the cap. Approach
sidedef `belowType = 0` and passable, so `move.c:549` short-circuits and the client imposes no
limit; `canCrossWallAt` agrees at the real standing floor; `traceFineMoveClient` refuses
`step_too_high`. The far sidedef carries `belowType = 1`, making it a **one-way climb** — a class
worth knowing, and now filed in `movement-authority-split.md`.

**And it moves nothing.** Both take-offs are already in the arrival flood and all three landings
are already reached another way: granting them adds **+0** samples to a 54,849-sample flood, and
the meld box stays at **0 of 400**. So the correct scoping is not "latent everywhere" but
**active once, in the room we care about, and still worth nothing.** Fixing the rule today moves
no stone.

589's 7 wall-less crossings are not slopes — that room has none — and are most likely residue of
the strict-inequality instrument failure fixed in the same pass.

## 13. The method finding, which outlasts all of it

Five defects and four retractions came out of this, and **every retraction came from the other
party, never from the author re-running their own tool more carefully.** The reason is worth
stating precisely, because the obvious lesson is the wrong one.

Each of the four wrong numbers was **correct inside the instrument that produced it**:

| the number | true statement about | wrong answer to |
|---|---|---|
| "37 ungated over-cap walls at the node's floor" | `canCrossWallAt` at `z = 0` | is there a free climb here |
| "80.8% of refused pairs cross no wall" | *proper* segment intersections | what gates these moves |
| "8 free climbs in 589, one 224 below the stone" | the lower-wall texture band | how tall is the step |
| "`gravityAdjust` makes jump range frame-rate dependent" | the constant, read alone | does the arc change with dt |

None was sloppy. None was catchable by running the same tool again, more carefully, or with more
samples — because the error was in **what the tool measured**, not in how well it measured it.

So the rule is not "get a second opinion". It is:

> **When a measurement comes back clean and confident, ask what it is a measurement OF — then
> find an instrument that answers the same question a different way.**

All four fell the moment somebody did that, and all four were produced by people being careful.
A second reader here was not a check on rigour; it was a second instrument.

## 14. Badlands (45) closed: the stone is on a mesa

Measured two ways, agreeing. The node at (63,46) sits on a plateau at floor **4096** — 289
squares at exactly that height, 516 if you include the 4480 shelf within a step of it — and it is
a mesa.

| | |
|---|---|
| cheapest positive square-to-square climb onto its perimeter | **+1280**, (r53,c32) 2816 -> (r54,c33) 4096 |
| reachable ground above 4096 within 6 squares of the plateau | **0** |
| plateau squares reachable from either arrival | **0** |
| meld box samples reached (64-unit fine flood, both arrivals) | **0 of 400** |

All three routes close on the physics in §2 and the movement report: a walk cannot climb 1280
against a 384 cap, **a jump gains no height at all**, and a fall-jump needs a reachable take-off
above the landing within range — there is none within six squares.

**"Below some reachable ground" is not "reachable by descending".** The arrival flood reaches
640..7231, so the stone at 4096 *is* below reachable ground, and that fact is worth nothing
because none of the high ground is adjacent to the plateau. That mistake was made twice in one
session, once in each direction: counting **standable** squares above the plateau (17,797, all
unreachable) and counting squares a flood reached without asking whether a body could reach the
seed. Ask where the ground is, not just how high it is.

**Two corrections to this section's first draft**, both the same shape as everything else in §13:

- `r60c46` is **2432**, not 4096. It is not on the plateau. A "something once thought this was
  reachable" lead was built on misreading a column out of a grid this file had itself printed,
  and it sent another session looking for ten minutes.
- A "cheapest climb" computed as *plateau nominal height minus neighbour floor* is not a rise
  between any two squares, and understates every perimeter climb by however far the local shelf
  sits above nominal. Compare square to square, and exclude descents — a minimum over a set that
  still contains negative rises returns a descent as the cheapest climb.

**Where the four stand.** 27 has a route and is blocked on a deploy, not on movement — the live
broker still carries the old `F * 1.5` cap. 45 and 515 are terrain, measured and closed. **589 is
the only one nobody has finished**, and its three arrivals — including the Temple of Qor's timed
exit at `tempqor.kod:80`, which nobody has used — are where to start.

## What I would do with this, in order

1. **Flood over `(cell, carried z)`.** It closes the format gap in `m59-falljumps.json`
   permanently, it subsumes `fallTargets`, and it is the only item here that makes the *next*
   gap cheap — which is the skill's actual deliverable. Everything else on this page is a
   constant.
2. **Bake room 1006 in both column states** and route to the down state. That is one node, and
   it is one `m59-doorbake.mjs` invocation pointed at sectors 4 and 5 rather than a door.
3. **Fix the three constants in `fallTargets`** (§3) if the flood is more than a day away —
   they are a one-line change each and they will move Badlands and Peak on their own.
4. **Drop `zMin` from the conjunct at `m59-roo.mjs:1112`.** One word.
5. **Add node state and clock to the diagnosis checklist.** Before concluding a node is
   unreachable, check `piState` is not `NODE_DEAD` and, for 599, that it is game hour 0.
6. **Put the five undocumented nodes in the book.** Four of them are timed or karma-gated, which
   makes them a different kind of test than the terrain seven — and `NODE_Q` in room 47 has had
   no attempt at all.

## What I could not settle from source

- Whether the treads in **45** and **515** are legal steps the walker cannot spell, or a genuine
  fall-jump. That needs the fine floors, and the §2 table is the ruler to measure them with:
  if consecutive fine rises are each ≤ 384 it is a staircase, and the staircase detector in
  `SKILL.md` backlog item 3 is the tool.
- ~~`gravityAdjust` makes the jump range frame-rate dependent.~~ **WITHDRAWN 2026-09-10 — it
  does the opposite, and the arc is invariant.** Worked through: for `dt >= MOVE_DELAY`,
  `gravityAdjust = 100/dt`, so the per-frame fall is `(dt * v_z/1000) * (100/dt) = v_z/10` and
  the per-frame gravity increment is `GRAVITY/10` — **both independent of `dt`** — while
  horizontal travel is a flat `2*MOVEUNITS` per frame. For `dt < MOVE_DELAY`, `gravityAdjust`
  is 1 and horizontal is scaled by `dt/100`, so the *ratio* is again independent of `dt`. The
  constant exists precisely to keep the trajectory frame-rate invariant, and it succeeds.
  One caveat that survives: `gravityAdjust` is set only inside `UserMovePlayer` (`move.c:215,220`),
  from the movement timer, while `MoveSingleVertically` runs off the **separate** animation timer
  (`animate.c:114`). While you are running they track each other, which is the fall-jump case.
  With no movement key held, `gravityAdjust` is stale from the last frame that had one.
