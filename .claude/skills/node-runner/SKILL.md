---
name: node-runner
description: Run a hero at Meridian 59's mana nodes as a movement EVAL. Each node is a terrain puzzle the mover currently fails; the deliverable is a named defect plus NEW DEBUGGING TOOLING that makes the next gap cheaper to find, never the stone. Use for "/node-runner <character>", for any mana-node attempt, and whenever a character cannot reach somewhere the router says it can.
---

# node-runner

```
/node-runner Loial the Ogier --node victoria                 one node, in full
/node-runner Loial the Ogier --all                           the whole book
/node-runner Loial the Ogier --node ancient --diagnose-only   measure, move nothing
```

## THE STONE IS NOT THE DELIVERABLE. THE TOOLING IS.

There are seven mana nodes and each is an **easter egg behind its own terrain puzzle** — a
staircase of treads too low for the walker to spell as steps, up to a high area, then a
sequence of jumps, sideways and *downward*, sometimes many, landing somewhere no walk could
reach. Some add monsters or a lever.

They are in this repository because **they are the standing test of the movement stack.** A
node is unreached because the mover is slightly wrong. But the point is not even to fix
that one wrongness:

> **The goal is to build the tooling that makes the NEXT movement gap cheap to find.**
> A node melded by hand teaches nobody anything. A node melded because somebody built a
> frontier report that named the refusing predicate in one command is worth more than the
> node, for ever, to everyone who clones this.

So the ranking is: **new diagnostic tooling > a repair with a test > a diagnosis > the
stone.** Getting the node without leaving the road open behind you scores zero.

**The operator's own words, and the thing to remember at 02:00:** *"the foundations of
movement for these kinds of tasks are always just slightly off, because that's the purpose
of doing the task, to fix our movement code — so you almost certainly can't get it by just
trying harder."* And: *"there's absolutely no value to getting these nodes without the full
script being runnable by everyone forever after."*

## AND THE ANSWER IS NEVER "IT IS IMPOSSIBLE"

The stones are reachable by regular players in the game client. That is not a hope, it is the
premise — they are easter eggs, they were designed to be got, and people get them. So a router
answering "no route" has proved something about `substrate/m59-falljumps.json` and the flood in
`reachableFrom`, and nothing whatever about the world.

**The mover being wrong is why the run exists.** What is missing is a jump, a ramp, a secret
passage or a triggered effect that our scripted understanding of the map does not carry —
finding which is the errand, not the obstacle. `unreachable`, `impossible` and `needs new
jumping mechanics` are inadmissible as terminal verdicts here, and the reason is measured rather
than moral: the column that predicts which stones the mover calls reachable is not the terrain,
it is **whether somebody wrote the jump down** — 579 and 589 have declared falls and are
reachable, and the four with no declared affordance are the four filed as impossible. Room 27
had exactly that property while the stone was already melded.

`node tools/m59-critic.mjs node` scores every stone against that, and
`.claude/skills/m59-critic/SKILL.md` is the critic that will not accept the answer. Run it
before writing up a node as anything other than reached.

## THE FAILURE THIS SKILL EXISTS TO STOP

2026-09-09, room 49 (Kardde's Canyon): eleven refused departures across two characters and
three destinations, then seven separate rim squares tried one after another, then Blink cast
on a hunch. Every attempt failed identically. The session produced one `KNOWN_TRAPS` entry
and **not one measurement of the geometry** — no fine-grid probe, no floor heights, no
`roomview`, no jump audit. That is a budget spent proving the same refusal eleven times.

**After the SECOND identical refusal, stop moving the body and start measuring the ground.**
A third attempt with the same inputs is not evidence. The wedge arm that counts breaks at a
place exists because this exact loop once burned 589 breaks in 93 minutes and then 18
minutes dying on one square.

## THE GREENFIELD QUESTION, WHICH IS THE REAL WORK

Every run must end by answering: **what tool would have made this an hour instead of a
night?** Then build it, or write it into the backlog below with the measurement that
motivates it. This list is the skill's actual product; the nodes are its test suite.

The gap between the tools that exist and the question a stuck character poses:

| what exists | what it answers | the question it does NOT answer |
|---|---|---|
| `m59-roomview.mjs` | what every predicate thinks of each square, drawn | *which* square is the frontier, and why that one |
| `m59-fineroute.mjs` | is there a fine route, yes or no | when no: where did the flood stop, and what refused it |
| `m59-jumpfinder.mjs` | here are candidate jumps | why a candidate was **never offered** — the 579 bug, silent |
| `m59-fineclimb.mjs` | follow a plan | which waypoint diverged, on which shelf, by how much |
| `m59-recordjam.mjs` | a room's bodies, as a committed fixture | replay it against changed code |
| tactics ledger | which tactic fired and whether it worked | counterfactual: would the *other* tactic have worked here |

**Four tools that do not exist and should.** Each is motivated by a specific measured
failure, which is the entry criterion:

1. **A FRONTIER REPORT.** `no route` is the least useful true answer in this repository.
   Flood from the body at fine resolution, then at the flood's boundary rank each frontier
   cell by how much closer a step outward would get you to the goal, and for each one print
   **the named predicate that refused that step** — `no_ground_gained`, `refused_edges`,
   `start_has_no_floor`, a step-height cap, a body in the way. This turns "it will not
   move" into "these six cells are one step from progress; five are refused by the 384
   step-height cap and one by a body at r44c13". Room 49 would have been one command.
2. **A JUMP AUDIT THAT EXPLAINS ITS REJECTIONS.** `jumpfinder` proposes; nothing says why it
   *declined*. The 579 staircase was blocked for a day because jump 1 was **silently never
   offered** — the flood had reached the valley half of a split take-off square, so the
   planner looked for a reachable cell at 10880 and found none. A tool that enumerates every
   candidate pair near the frontier and prints a rejection reason per candidate — *"take-off
   r40c33: nearest flooded cell inside it stands at 3520, take-off needs 8640"* — converts
   the whole class of silent-omission bugs into a printed line.
3. **A STAIRCASE / LADDER DETECTOR.** The operator says the answer for most nodes is
   climbing treads of low height to a high area. The walker cannot spell those treads as
   steps. So find them directly: monotone ascending chains of fine cells where each rise is
   within `MAX_STEP_HEIGHT` (384) and the run is walkable at `PLAYER_RADIUS`, and report them
   as a climbable ladder with its boarding cell. The 579 staircase is 5152 → 5504 → 5856 →
   6208, +352 each — legal every tread, and invisible unless you board at the bottom.
4. **SCENE CAPTURE AND REPLAY, which is the highest-value one.** Monster collision is
   height-agnostic and is **the only source of non-determinism** in an otherwise
   deterministic model: the same climb walked 47 waypoints once and fell at 15 on the next
   run of identical code. Until a scene is reproducible, every movement fix is a guess
   measured against a moving target. Capture the room's movable and route-blocking objects
   with their exact positions, plus **the git SHAs of what was actually launched *and* what
   was on disk**, then recreate it on the shadow server: clear the room's monsters, teleport
   any real players out to Familiars (map 52), and put the recorded monsters back in exactly
   their configuration. `m59-recordjam.mjs` already captures and redacts the bodies — this
   is its replay half, and it is what turns each node into a regression test instead of an
   anecdote.

## READ THIS BEFORE §"measuring the ground" — the source disagrees with three of our rules

`FROM-RESEARCH-2026-09-10.md` in this directory, 2026-09-10, read from `C:\code\Meridian59`
at `1fb1f514`. The three that change what a run should do:

- **The flood cannot see a jump, and that is why the file only holds falls.** `moverStepLands`
  re-seeds the body's height from the from-square every step (`m59-roo.mjs:2471`, no `motionZ`,
  `fall` false). A drop-jump is a property of a SEQUENCE. `m59-falljumps.json` is not missing a
  `kind`; the flood is missing a dimension. Backlog item for the greenfield question: flood over
  `(cell, carried z)`.
- **"Downhill only" is wrong by 384 units, and a jump is a distance budget rather than a shape.**
  Running is 5 squares/s and the fall is `682.67t + 2560t^2` client units. So a landing may be
  **+145 above** the take-off at one square and **exactly level at 1.38 squares**; from a
  3.5-square drop a body crosses **5.34 squares**, not the 3 `FALL_MAX_SQUARES` searches.
- **1006 is a lever puzzle, not terrain.** The node rides a column at floor 500 that drops to
  105 when the last monster in the final chamber dies. Do not spend a night jumping at it.

Also: there are **thirteen node bits in the kod, not seven**; node state (`NODE_DEAD`) refuses
the meld before the range test and is visible on the wire as `ANIMATE_NONE` group 8; and room
599 holds an undeclared node that exists for 5 real minutes in every 2 hours.

## What "measuring the ground" means

**THE FINE GRID IS THE REALITY; A SQUARE IS A SUMMARY, AND ON INTERESTING GROUND IT IS A
FALSE ONE.** `r40c33` in the Ancient Place spans floor 3520 to 10880 — the valley floor
*and* the high ledge, one square, one number. Ask the coarse grid where the floor is and it
answers per square; ask it about a ledge and it lies.

A diagnosis is built in this order:

1. `node tools/m59-roomview.mjs <room>` — read it **before forming a theory**. Everything it
   draws is read through the modules the broker really moves on, never re-derived.
2. Fine floor heights at the take-off, the lip, and the landing — corners *and* centre at
   `PLAYER_RADIUS`. One sampled point on a ledge is a coin toss and once let a 3648-unit
   fall through as level ground.
3. `node tools/m59-fineroute.mjs` — offline, plan-only, closures as nodes and jumps as edges.
4. What is standing in the room, because a body in a gully blocks a hop above it.

## The traps that make you diagnose the wrong thing

- **A footing search takes the HIGHEST floor in a square**, which on a split square is the
  wrong world. Take-off `r40c33` guessed 10880, the operator stood at 8640; landing `r40c32`
  guessed 3200 (valley), actual 7040.
- **Testing a take-off with `seen.has(exactFineCell)` repeats the split-square bug.** Ask for
  a flooded cell inside the take-off square *standing at the take-off's height.*
- **A FALL IS CONFIRMED BY THE SERVER, NOT THE REPLY.** The reply is pessimistic by
  construction and the body is still on the take-off if you read at once. Wait ~3s. Reading
  immediately recorded a working jump as a no-op twice.
- **`arriveWithin` defaults to 40 KOD units** = 2/3 of a square, so a line-up "arrives" a
  square and a half short. Use `arrive_within: 6` for a take-off.
- **A declared `to_fine` must go in the aim chain the jump actually reads**
  (`laneAim ?? standPointWire ?? square centre`), or it aims at the square centre — the
  gully, on a split square.
- **`path(a->b)` succeeds where BFS fails**, because A* exempts the goal from
  `moverStepLands`. Test chains with a BFS, never a sequence of `path()` calls.
- **Descent is unbounded; only climbing is capped.** A never-descend closure is right for
  carving ledges and wrong for routing.
- **`start_has_no_floor` usually means position and geometry are from DIFFERENT ROOMS.**
- **Three coordinate spaces.** `FINENESS` is 64 in kod, 1024 in the client; `walk_to` takes
  kod PROTOCOL units and client units walk the body off the map. Use `tools/m59-coords.mjs`
  and `expectUnit(p, 'client', where)` at every boundary.
- **The server is 2-DIMENSIONAL; height is ours.** When a plan is refused for a reason that
  makes no three-dimensional sense, you have asked a 2D authority a 3D question.

## Where the nodes stand

Reachability is a claim about **which movement code is running**, so it lives in the
`m59-fleetscript.mjs` header beside the `#movement` epoch convention. A run that comes up short
reports the state of the mover, not a fault in the errand — and never a fact about the terrain.

**THE OLD TWO-ROW TABLE HAS BEEN RETIRED.** It read "reachable with the code as it stands" against
"NOT reachable — needs new jumping mechanics", and the right-hand row was wrong twice in one day:
750 is ONE square off, inside the meld box, by walking alone, and 45 is three. The row was never a
measurement — it was a record of which stones somebody had got. Replaced by how far the mover
actually gets, measured 2026-09-10 with `m59-exitreport.mjs <room> --to <rNcM> --box 2`, Chebyshev
from the square a body lands on coming in. Anything at 2 or less is already inside the 5x5 box.

| room | node | off | declared jumps | what that says |
|---|---|---|---|---|
| **39** | Castle Victoria | 0 | over 599's fall | reachable from the EAST doorway only; 22 short from the other |
| **579** | Ancient Place | 0 | four | carried by the declared falls |
| **589** | Sentinel | 0 | one | only across `r35c16 -> r38c19`, and only entered from 599 |
| **750** | Ice Caves | 1 | none | INSIDE the box by walking. Filed as needing new mechanics; it needs none |
| **45** | Badlands | 3 | none | one square outside the box, from `r60c46` |
| **27** | Icky Cave | 4 | **none** | MELDED ANYWAY, 2026-09-09. The route is a jump nobody has declared |
| **515** | Seafarer's Peak | 5 | none | nothing measured beyond the walking flood |
| **1006** | Mausoleum | 10 | none | and no route to the room from Tos at all |

Every `off` above is a statement about WALKING and nothing else. `reachableFrom` floods with
`moverStepLands` one square at a time; a fall is not a step, so a stone across one reads as
unreachable at whatever distance the flood happens to stop. `node tools/m59-critic.mjs node`
prints this table live against the falljumps file rather than from this page.

`substrate/mananodes/<agent>.json` records what a character holds and how it was got;
`node tools/m59-fleetbook.mjs mana-nodes` is the recipe.

**There is no client-facing list of melded nodes.** `GetNodeList()`/`NumManaNodes()`
(`player.kod:6178`) are kod-side only. The observable is **MAX MANA**: `ComputeMaxMana`
rebuilds it from the `piNodelist` bitmask on every login. Per node, stand on one and
activate — a ceiling rise means melded, no change means already bonded *or out of range.*
The grant is `((5 + Mysticism) / 10) + 3`, so +3 at mysticism 0 and +8 at 45 and up.

## Running one node

**0. Read `FROM-RESEARCH-2026-09-10.md` and then `nodes/<key>.md` in this directory first.**
The first is what the SOURCE says — the client's real step predicate, the fall-jump reach
table, and the three stones that are not terrain problems at all. The second is what previous
runs measured. A run that re-measures a solved half has spent its budget on it.

**1. Park and hold the hero.** A fragile caster left unheld is walked into open country by
its own keeper within minutes — measured: 90 seconds unheld took a 20-health character from
an inn to the Sweet Grass Prairies. Orders go through FleetScript, which takes the lease,
cancels the in-flight journey and puts a health floor under it.

**2. Treat the approach and the stone as two questions.** Arriving in the room is not
arriving at the node. The meld test is a **5x5 box, not a radius** — `abs(drow) < 3 AND
abs(dcol) < 3`, per axis (`mananode.kod:177`).

**3. On the second refusal, switch to measuring.** Produce the roomview, the fine floors,
the fineroute verdict, and the room's bodies. **Name the predicate that refused** — the fix
differs for each, and "it will not move" is not a diagnosis.

**4. Build the tool, then the repair, or write the handoff.** A repair lands with a test and
`#movement` in the message, because the ledgers key on that tag. A handoff names the file,
the line, the measurement, and the **one question** only the operator can answer.

**5. Update the dossier either way.** A null result is a result: what was measured, what the
predicate said, what it is not.

## What a pass looks like

| outcome | verdict |
|---|---|
| a new diagnostic tool that names the defect in one command, plus the repair | best |
| defect named and repaired with a test; node still short for a *different*, named reason | pass |
| defect localised to file and line with fine-grid measurements, handed over with one precise question | pass |
| node melded by hand or by luck, nothing learned, no tool left behind | **fail** |
| "tried several approaches, could not get there" | **fail** |
| a theory with no fine-grid measurement behind it | **fail** |

## Do not

- Do not brute-force rim squares, headings or destinations. Two identical refusals is the
  signal to stop moving and start measuring.
- Do not re-derive geometry. A view that computes its own floors is a second opinion about
  the map rather than a look at the one in play.
- Do not conclude from silence. A refused cast, a refused merchant and a refused move are
  sentences rather than errors here, and a channel that returns nothing for a *working*
  spell proves nothing about a failing one.
- Do not strand a character. If you do, it goes in `KNOWN_TRAPS` with the evidence — that is
  how 599 and 49 got there — and the fleet stops routing into *and through* it.
- Do not point the maintenance port at a shared server. `m59-node-run.mjs` refuses a
  non-loopback fleet; `--on-shared-server --agents <a>` is the deliberate escape hatch,
  capped at two, and its DM placement step cannot work there at all.
