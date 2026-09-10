# ice — NODE_ICECAVE1, room 750, stone at r25c23

**The stone is INSIDE the meld box by walking, and it needed no new mechanics at any point.**
The retired two-row table in `SKILL.md` filed this one under "NOT reachable — needs new jumping
mechanics". It is one square off the walking flood and the entry square can reach it.

## Why nobody had got it

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

- The walk is the whole errand. If a run comes up short, the useful question is which square it
  stopped on relative to r46c25 → r25c23, not what mechanic is missing.
- **The room's name is the only warning worth keeping**: it is the Dreaded Caves of Ice and it
  is a monster room. A 20-health body is at the max-health floor, so a death costs nothing
  permanent (`piMax_health` is bound below at 20, `player.kod:5930`), but a corpse run costs the
  session.
- The observable for a meld is **MAX MANA**: `ComputeMaxMana` rebuilds it from the bitmask on
  every login, and the grant is `((5 + Mysticism) / 10) + 3` — so +3 at mysticism 0. There is no
  client-facing list of melded nodes; a ceiling that does not move means already bonded, or out
  of the box.
