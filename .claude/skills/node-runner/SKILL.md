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
`m59-fleetscript.mjs` header beside the `#movement` epoch convention. A failure on the
right-hand column reports the state of the mover, not a fault in the errand.

| | nodes |
|---|---|
| reachable with the code as it stands | **27** Icky Cave, **39** Castle Victoria, **579** Ancient Place, **589** Sentinel |
| NOT reachable — needs new jumping mechanics | **45** Badlands, **515** Seafarer's Peak, **750** Ice Caves, **1006** Mausoleum |

`substrate/mananodes/<agent>.json` records what a character holds and how it was got;
`node tools/m59-fleetbook.mjs mana-nodes` is the recipe.

**There is no client-facing list of melded nodes.** `GetNodeList()`/`NumManaNodes()`
(`player.kod:6178`) are kod-side only. The observable is **MAX MANA**: `ComputeMaxMana`
rebuilds it from the `piNodelist` bitmask on every login. Per node, stand on one and
activate — a ceiling rise means melded, no change means already bonded *or out of range.*
The grant is `((5 + Mysticism) / 10) + 3`, so +3 at mysticism 0 and +8 at 45 and up.

## Running one node

**0. Read `nodes/<key>.md` in this directory first.** It is what previous runs measured. A
run that re-measures a solved half has spent its budget on it.

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
