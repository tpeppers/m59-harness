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
