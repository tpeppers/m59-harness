# ice — NODE_ICECAVE1, room 750, stone at r25c23

**THE ERRAND HERE IS THE APPROACH, NOT THE MELD.** Operator, 2026-09-10: *"the Dreaded Caves of
Ice node requires killing the Yeti to get access... so while we can include it in 'the walk',
for both the Fey Node and the Yeti Cave, the goal should actually just be to walk to within a
few coarse squares away from the mana node (in the dreaded caves this means the biggest room)."*

So success for this stone is **within 5 coarse squares of r25c23**, and the meld is a separate
question for somebody who means to fight for it. `objective: 'approach'` in
`tools/m59-stones.mjs` is that, and `m59-node-run.mjs` judges the leg on it.

## What the geometry says, and why it is not the whole answer

**The walking flood reaches the stone.** That is true and it was the first thing measured here,
and on its own it is misleading — which is worth keeping written down, because it is the exact
shape of a confident wrong answer. The retired two-row table in `SKILL.md` filed this stone
under "NOT reachable — needs new jumping mechanics"; the flood says it is one square off. Both
of those are statements about the BAKE.

**The kod gates it with a ceiling that moves** (`icecave1.kod`):

```
MANA_DOOR = 2            MANA_DOOR_TIME = 2000

SomethingKilled(what, victim)
   if IsClass(victim,&yeti)
      % Don't open the door if the Yeti was killed by a node attack.
      setsector MANA_DOOR ANIMATE_CEILING_LIFT height=510
      ptManaDoor_Timer = CreateTimer(self,@LowerManaDoorTimer,MANA_DOOR_TIME)

LowerManaDoorTimer()   -> setsector MANA_DOOR height=380
```

A yeti kill lifts the sector to 510 for **two seconds** and then it drops back to 380 — and it
does not lift at all if the node's own attack made the kill. So the meld is a kill plus a
two-second window, and a claim that the square is "reachable" is a claim about one frame of an
animated sector.

**AND THAT IS A GENERAL GAP, NOT A DETAIL ABOUT THIS ROOM.** `substrate/m59-map.json` bakes
sector heights once. 44 kod room files call `setsector ... ANIMATE_`, and
`MUTABLE_GEOMETRY` in `tools/m59-mutable.mjs` lists ten rooms, nine of them from an operator
recalling them in one afternoon. Among the 44 and not on that list: `i9.kod` — **Ukgoth, room
599**, the gutter every Castle Victoria run crosses — and four of the node rooms
(`icecave1`, `cave2`, `h9`, `canyon2`). Whether each belongs in that table is a judgement about
how OFTEN the geometry moves, which is why this is written here as a question rather than
committed as a list.

## Why nobody had even walked to it

Not the terrain. **The circuit could not be asked for it.** `m59-node-run.mjs` kept its own
hand-written list of six stones and this was not on it, while `fleetscripts/mana-node.mjs` kept
a different hand-written list of seven that was. There was no way to say "go to the ice node"
to the tool that walks nodes.

The census that found this is `node tools/m59-stones.mjs --diff`, written 2026-09-10. The
authority is the bitmask in `kod/include/blakston.khd` — **thirteen** node numbers, each one bit
of the player's `piNodelist`, which `ComputeMaxMana` sums on login. Both lists here were
hand-written, disagreed in both directions, and neither was checkable.

## The measurement, 2026-09-10

`node tools/m59-exitreport.mjs 750 --to r25c23 --box 2 --checked`:

```
room 750 — The Dreaded Caves of Ice — 47x45 squares
  3 region(s); the main one is 1 with 2114 of 2115 walkable squares

  DOORS OUT
    south  to 526   r47c24   region 1   on the body

  WHERE YOU LAND COMING IN
    from 526  Druid Hills  -> r46c25
             from that square you can WALK to: south to 526 at r47c24
             and r25c23 (or within 2 of it) is REACHABLE by walking from there
```

Read that last line before theorising about anything: **the arrival square reaches the stone**.
One region holds 2114 of 2115 walkable squares, so there is no pocket problem here either.

- **Approach**: enter from **526 (Druid Hills)**, land at **r46c25**, walk to within 2 of
  r25c23. The meld test is a 5x5 box — `abs(drow) < 3 AND abs(dcol) < 3`, per axis
  (`mananode.kod:177`) — not a radius.
- **The room's only door out is south to 526** at r47c24, "on the body", so leaving is the same
  square you arrived beside. There is no second exit to get lost looking for.
- **Route**: 5 hops from room 202, plannable in the bake, no hazard on the way.

## What the run cost, and the two defects it found

Marco Polo (hk2, 20/20, max mana **25** before) was sent 2026-09-10 with
`--agents hk2 --nodes ice --on-shared-server --no-broadcast`.

The first attempt **died before walking a step**:

```
Error: connect ECONNREFUSED 127.0.0.1:19998
```

19998 is the maintenance port. It is unauthenticated, `m59-dm.mjs` refuses a non-loopback host
by design, and this skill's own page says the DM placement step "cannot work there at all" — and
the runner tried it anyway, first, every run. The proximate cause was one missing `.catch`
(`dm.relocate` and `dm.heal` had one, `dm.resolve` did not), but the fix is not a catch: with one
the run would have believed it had teleported the character to the start line and topped up its
vitals when it had done neither, and every road it measured would have been from somewhere else
at some other health. The DM is now a decision (`DM_OK`, loopback only) and the header says
"first leg from wherever each body is standing".

The header had also been printing `first leg from room 50` while the character stood in 202 with
nothing able to move it — false at the moment of printing.

## What to do next here

- The walk is the whole errand, and it is now declared that way. If a run comes up short, the
  useful question is which square it stopped on relative to r46c25 → r25c23, not what mechanic
  is missing — and a failed leg now prints that itself (the FRONTIER line).
- **Do not read a successful approach as a meld.** Max mana is the only observable, and it will
  not move: the stone is behind the yeti.
- **The room's name is the only warning worth keeping**: it is the Dreaded Caves of Ice and it
  is a monster room. A 20-health body is at the max-health floor, so a death costs nothing
  permanent (`piMax_health` is bound below at 20, `player.kod:5930`), but a corpse run costs the
  session.
- The observable for a meld is **MAX MANA**: `ComputeMaxMana` rebuilds it from the bitmask on
  every login, and the grant is `((5 + Mysticism) / 10) + 3` — so +3 at mysticism 0. There is no
  client-facing list of melded nodes; a ceiling that does not move means already bonded, or out
  of the box.
