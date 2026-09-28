# Seafarer's Peak — room 515, r20c17

## 2026-09-28: `peak_lower_shelf_boarding`

Quiet local shadow trial `peak-1790612701261` started r50c31,
client (31232,50688), floor 5056. A bounded normal walk stopped after 28 steps
at r38c25, client (25552,38304), **still floor 5056**. Receipt says
`kept ending up somewhere other than the planned square`. Health stayed 20/20;
no activation, administrative recovery to room 52 afterward.

Exact-endpoint floods from the entrance at 128 and 64 units visited 57,909 and
229,775 points respectively, reached zero meld-box points, and had highest floor
8896. These are planner bounds, not proof of impossibility. Runtime files:
`peak-flood128.json`, `peak-flood64.json`, `peak-1790612701261-commands.jsonl`.

Do not seed a new plan from a representative point in the reported square: `m59-gap 515
--from 38,25` selects footing (24704,38016) on **12432**, 7376 above the actual body. Its
`peak-frontier.json` output is retained as evidence of that starting-state
mismatch, not as the live body's frontier. The square centre (25088,38400)
itself is on 5056; calling 12432 the centre height would also be wrong.

Next experiment: sample a boarding chain from the actual (25552,38304)/5056
floor, keeping every rise at or below 384 client units and checking the exact
body radius. Test a finer/lattice-shifted approach to the 8896 frontier before
inventing a jump. Jumps do not buy height. Roomview: `m59-roomview.mjs 515`.

The follow-up actual-phase audit seeds the exact stopped body, without snapping:
64-unit phase (16,32) visits 228,323 points; 32-unit phase (16,0) visits 914,598.
Neither hits its 1,500,000 cap. Both have zero meld-box samples, highest floor
8896, and nearest r25c13 on floor 5824. See `peak-actual-phase-floods.json` and
`peak-phase-audit.mjs`. The next experiment should inspect an alternate entrance
or a specific wall-459 collision disagreement rather than repeat this flood.

`peak-highest-frontier.json` records the exact highest visited point at the
128-unit resolution: client (7296,12288), floor 8896. Its immediate neighbors
descend or remain level; there is no adjacent higher point in that sampled
component (`peak-upper-boundary.json`). A jump to the node would have to gain
height. The remaining question is an alternate fine passage, not a larger jump.

Reusable bounded recipe: `node-trial node=peak row=50 col=31 route=coarse
quiet=true` through FleetScript. No verified route, meld, or walking escape yet.
