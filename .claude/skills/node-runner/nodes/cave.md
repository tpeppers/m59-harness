# cave — NODE_ORCCAVES, room 27, stone at r23c53

**SOLVED 2026-09-09.** Loial the Ogier melded it; max mana 25 -> 33 (+8 at mysticism 50).

## The puzzle is the DOOR, not the terrain

Room 27 has **no inbound exit and that is not a hole in the bake.** Nothing in the world
graph has an exit into "A Deep, Dark, Spooky, Icky Cave". Its only inbound links are from
room 5 (The Underground Lake) and room 2500 (Ugol's Warren Entrance), both inside the same
cave complex — an island of rooms a breadth-first search from Tos never reaches.

You get in by **walking onto a trigger**. `h7.kod`, room 587 (Western border of the Twisted
Wood, two hops from Tos, on the main road out):

```
if (new_row < 18) and (new_col < 7) and (new_row > 14)
   UtilGoNearSquare(what, RID_CAVE2, new_row=57, new_col=46, ANGLE_NORTH)
```

Rows 15-17, columns 1-6. Stand there and you are put into room 27 at r57c46. There is a
second trigger in `forest2.kod` (room 26, rows <19 and cols <7, landing r55c35), but room 26
is not reachable from Tos either, so **587 is the door.**

**The router cannot plan through this and is RIGHT not to** — a trigger is a square with a
consequence, not an exit, so `travel` truthfully answers "no route". Do the two halves by
hand and report which half failed; a leg that never reached 587 and a leg that stood in the
corner and was not teleported are different findings.

## The sequence that worked, exactly

1. `come-home agents=<hero> home=587` — arrived at **full health** with a 60-health
   companion along. (The one death of the night was a *different* route, through 599.)
2. `walk_to col=4 row=16` — the middle of the trigger box, so a step either way is still in
   it. Reply was `{arrived: false, left_room: true, steps: 3, note: "a proved leg crossed
   the room edge"}` — **`arrived: false` is the correct and expected answer here**, because
   the body was teleported out from under the walk.
3. `walk_to col=53 row=23` in room 27 — `{arrived: true, steps: 19, replans: 0}`.
4. `node tools/m59-mananode.mjs --agent <hero>`.

## Traps this node taught

- **`m59-mananode.mjs` was unrunnable** and the crash was *after* the activate, so the grant
  had been landing while the tool could not say so. Two fall-through shape bugs, fixed in
  `efcafe4`; it now proves a meld by the mana ceiling instead of parsing prose.
- The whole approach is a town road. **Nothing here needs a jump.** That is why this is the
  tractable node and the right one to start a `--all` run on.

## CORRECTION, 2026-09-10: THE ROUTER PLANS THIS NOW, AND THE HAND-DRIVEN RECIPE IS WORSE

Everything above about *why* room 27 has no ordinary way in is still true. What is no
longer true is the instruction that follows from it — "the router cannot plan through this
and is RIGHT not to... do the two halves by hand."

The bake in play carries the h7.kod trigger as a **region exit**. Asked from a character
standing in 587, the keeper's own router answers in one hop:

```
587 -> 27   kind: "region"
"walk into the part of this room where row < 18 and col < 7 and row > 14 —
 the room moves you across by itself, there is nothing to press"
```

So `walk(27)` through fleetScript is the whole approach, and it keeps the health floor, the
budget sized from the road's own p90, and the lease. Ask the KEEPER for that route
(`/action {name:"route", to:27}`) — the broker holds a snapshot, not a World, and answers
`route: {found: null}` for every keeper-backed character.

**Driving the trigger square by hand is now the failing path, and here is how it fails.**
`act('walk_to', {col: 4, row: 16})` across 587 returned

```
{ error: "The operation was aborted due to timeout", timed_out_after_ms: 60000 }
```

The 60 seconds is the **broker's** cap on its own RPC to the keeper — not fleetScript's
(`act` passes 120s, `call` defaults to 180s) and not the walk's budget. The keeper went on
walking; only the answer stopped. fleetScript scored it as a step failure, unwound, and
handed the lease back — so Marco Polo was unheld in the Twisted Wood and went 20 -> 12
inside the minute. `walkTo(col, row)` in `m59-fleetscript.mjs` is the fix: issue once, read
the world back, re-issue at most once on a genuine stall. Its `leaveRoom: true` option is
for exactly this square, because on a trigger, **arriving is the failure and being moved is
the success.**

Two smaller things this leg cost:

- **`rest({ health })` will refuse in the Twisted Wood**, and that is the guarantee working
  rather than the errand failing — it walks to a safe wall and will not sit down in the
  open. Mark it `optional: true` on a road leg. For a character at the 20 max-health floor
  the trade is right: setting out hurt costs a corpse run and nothing permanent.
- **Marco Polo died to the orcs INSIDE room 27** on an earlier attempt (m59-harness-31,
  the same night). The road is easy and the cave is not; arrive with health or plan a
  corpse run.

## AND THE "SOLVED" AT THE TOP IS NOT SUPPORTED. MEASURED 2026-09-10.

Marco Polo (hk2, mysticism 50, max mana 25 = zero nodes) walked into room 27 and could not
get near the stone. Four measurements, all agreeing, and one of them is the server's:

| asked | answer |
|---|---|
| coarse flood from anywhere in the room body (`reachableFrom`, `moverStepLands`) | 1300 squares, and `r23c53` is not one of them |
| `route_fine 27 -> r23c53` (the live keeper, 38 seconds) | `no route to 23,53 within 4 jump(s)`, after flooding 16458 fine points / 1316 squares |
| a real walk, 300s of budget | `r27c41 -> r24c11 -> r22c23 -> r47c30 -> r21c45` and stopped, 8 squares out |
| standing on the nearest square the mover CAN reach, `r19c57` | the SERVER's own `look` puts the node at distance **6**; `activate` returned no messages at all; max mana **25 -> 25** |

**The stone is on a one-way ledge, and the direction is the whole finding.** Flooding *from*
`r23c53` reaches **1469** squares including the entire room body; flooding from the body
reaches **1300** and never the stone. You can walk down off it and not up onto it. An
undirected model welds the two together and reports a square nobody can stand on.

The nearest reachable square is `r19c57` — Chebyshev **4** — against a meld box of **2 per
axis**. One command says all of it:

```bash
node tools/m59-exitreport.mjs 27 --at r47c30 --to r23c53
#   r23c53 itself is NOT reachable by walking from there
#   the closest the mover gets is r19c57, 4 square(s) off
#   and no DECLARED fall in this room bridges the gap
```

It predicted the exact square the body would stop on before the body set out.

**So both witnesses for the 2026-09-09 meld are known-bad instruments.**

- `walk_to col=53 row=23 -> {arrived: true, steps: 19}` — nineteen steps cannot cross
  thirty-four rows, and that walk ran **before** `2de4001` ("walk_to reported arrival without
  moving, at a tolerance of 1.5 squares", authored 2026-09-10T03:55Z) was deployed. It is the
  signature of that bug.
- `max mana 25 -> 33` — a delta read across a **login recompute**. `ComputeMaxMana` rebuilds
  the ceiling from `piNodelist` on every login, so a reading taken on a freshly joined session
  understates it. m59-harness-b9 measured exactly this on the same character the same night:
  hk1 read `max 25` and then `max 65` across a fleet-wide keeper restart with nothing walking
  anywhere in between.

That does not prove the meld did not happen — it proves nothing witnessed it. **Do not treat
this node as solved.** If somebody wants to settle it, the test is cheap and it is the one
that survives both bugs: read hk1's max mana twice on the SAME keeper pid, well after login,
then stand it where Marco stood and activate.

**`approach` is dead on prod and fails silently into this.** `call('approach', {agent,
target, distance})` returns `error: "s.world.approachSquare is not a function"`.
`tools/m59-mananode.mjs` calls it with `.catch(() => {})` and falls through to `walk_to`, so
its documented "ask to be adjacent, then CHECK the real rule" has been half a step for as
long as that function has been missing.

**What would actually get this stone**, in the order the skill ranks them: a jump audit that
explains its rejections (is there a take-off on the body from which a declared fall lands
inside the box?), or a fine-grid climb up the ledge if one exists. Neither is "try walking
again" — the walk has now been measured four ways.

## RETRACTION, 2026-09-10, SAME DAY: THE MELD IS CONFIRMED. MY MODEL WAS THE THING THAT WAS WRONG.

**The operator went back to this node to get it and found it already taken.** That is direct
confirmation of the 2026-09-09 meld, and it settles the section above, which argued from two
unreliable instruments to the wrong conclusion.

Everything measured above is still true and none of it means what I said it meant:

| what I measured | what it actually says |
|---|---|
| coarse flood reaches 1300 squares, not `r23c53` | the mover cannot **walk** there |
| `route_fine` says `no route within 4 jump(s)` | its **candidate generator** found no jump there |
| a walk spent 300s and stopped 8 squares out | that walk did not get there **that time** |
| standing at `r19c57`, distance 6, ceiling unmoved | `r19c57` is out of the box, which was already known |

Not one of those is a statement about the world. They are all statements about the model,
and **the model is missing a jump.** Room 27 has NO entry in
`substrate/m59-falljumps.json` — so a walk flood cannot see the route, `--to` reports "no
DECLARED fall in this room bridges the gap" (which is true and reads as though it settles
something), and `route_fine`'s jump search only finds candidates it can derive.

**AND THE OPERATOR NAMES THE MECHANISM FOR THE INCONSISTENCY: A MONSTER BLOCKING THE JUMP.**
In his words, that is the most common cause of this kind of inconsistency he has seen. It
fits everything here — monster collision is height-agnostic, so a body standing on the
take-off, in the arc, or on the landing refuses the move exactly like a wall, and room 27
carried **six orcs** on the night Marco failed. The same jump on the same code succeeds or
fails depending on where the orcs are standing, which is why one session melds it and the
next measures it as unreachable.

**The rule this broke.** CLAUDE.md: *a claim that contradicts what is already written down
needs a reproduction before anything is decided on it.* I had one afternoon's refusal against
a written record, and I wrote up the record as unsupported. The reproduction that was actually
needed was **the same attempt with the room's bodies in a different arrangement** — because
the thing that varies is not the code, it is what is standing on the ledge.

**So the correct verdict for this node is: reachable, by a jump nobody has declared, and
INTERMITTENTLY blocked by whatever is standing in it.** What to do about it, in order:

1. **Declare the jump.** It belongs in `substrate/m59-falljumps.json` with `observed_by`, the
   way Ukgoth's and the Ancient Place's are. Until it is there, every planner in this
   repository will keep answering "no route" about a route the fleet has walked.
2. **Clear the room first, or come back.** A failed attempt is evidence about the orcs, not
   about the geometry. Two identical refusals in one visit is not the signal to stop — two
   identical refusals *across visits with the room in different states* is.
3. **Say which of the two a refusal was.** A tool that cannot distinguish "the ground refuses"
   from "something is standing on it" will keep producing this write-up.
