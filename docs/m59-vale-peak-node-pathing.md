# Vale and Peak node pathing, 2026-10-06

Vale's **spawn location** is now verified from its normal room entry and back,
**2 of 2 quiet native trials**, 74.5 and 75.3 seconds, 59/59 HP throughout.
Peak has **one verified upper-stair-to-node-to-normal-entrance trial**, 105.5
seconds, also 59/59 HP. Peak's entrance-to-upper-stair boarding remains unresolved:
that trial began at an explicitly authored high staircase point.

## Other node opportunities

| Node | Current evidence / gate |
|---|---|
| Victoria, Sentinel, Ancient, Badlands, Icky Cave | Existing promoted five-node circuit with connected quiet native evidence; not re-tested as a complete circuit here. |
| Vale of Sorrows, 532 | Normal entry r1c29 to exact spawn square r23c30 and walking return verified twice; the Fey stone is a faction outcome. |
| Seafarer's Peak, 515 | Upper-stair walk, one checked fall, node square r20c17, walking return to r50c31 verified. Normal entrance boarding is still missing. |
| Dreaded Caves of Ice, 750 | Previous investigation verified the big chamber approach and return; actual meld requires the yeti's mana gate. |
| Ukgoth | Relic of Qor, spoken words, opening window and game-hour gate. Existing conditional recipe; not a casual terrain-only acquisition. |
| Avar / Martyr | Faction swing / portal activation prerequisites; no new casual acquisition claimed. |
| Underworld / guest demonstration | Separate death/guest contexts; not new nodes to route the living fleet toward. |

No new acquisition is auto-promoted into the circuit. Vale remains conditional;
Peak lacks a normal entrance approach. No activation, faction alteration, yeti
fight or production deployment was performed by these trials.

## Vale measurements

Primary source: `kod/object/active/holder/room/monsroom/feyforst/c2.kod` in the
Meridian source tree. Room 532 uses c2.roo. The normal inbound from room 531 lands
at r1c29. The Fey stone is placed at r23c30 when the eight Fey forest rooms share
the required extreme karma alignment. Reaching an empty spawn location does not
create or meld it.

`SetRoomKarma` also changes floor sectors. The trial plans against the session's
current geometry, not a representative coarse-square height. Final receipts
capture observed sector-height messages. Both quiet runs reached KOD
**x1920/y1472**, r23c30 (the source's actual spawn point), then returned to r1c29.
The approach emitted 44 checked waypoints, return 45. These are room-local
pathing proofs; ordinary monster survival, other karma configurations and
connected town travel were not tested here.

## Peak defects repaired

`fineRouter.candidateJumps` previously marked a landing key as tried *before*
checking the first takeoff's arc. A failed low takeoff permanently hid that
landing from a later high takeoff. From Peak's normal entrance this produced
zero proposals. Moving that cache insertion after acceptance exposed 174 raw
proposals, including ones from floor 8896 rather than only the entrance's 5056.

Raw proposals are not physical proofs. An audit of those 174 accepted only 15:
12 had no centre floor, 140 were geometry-blocked, and 7 exceeded the actual
centre-floor span budget. These counts describe that sampled raw proposal set,
not all possible falls or the final planner's exhaustive options. The repaired
search now checks actual centre floors, timed collision traces and quantized
wire endpoints **before** remembering a landing or spending its branch budget.
It retains shared gravity, step-height and wall rules.

The plan also had a downhill-only gate, contradicting `maxSpan(drop + step)`
which permits level or small uphill falls. The gate is removed for undeclared
candidates; all physical and collision checks remain. Default routing still
uses declared falls only. No new declared fall or production route was added.

At the same authored upper-stair start, client **x5824/y24000**, floor 8448,
original a15c90a7 returned no route with one candidate jump; the repaired planner
finds the checked upper route. Normal entrance client **x31232/y50688**, floor
5056, remains outside it. A bounded repaired search (two falls, branch four,
14 closures, 75.4 seconds) did not find an entrance route. This is a search
boundary, not a claim that the retail route is impossible.

## Partial Peak native proof

The authored upper-stair start is **setup only**. The character walks to client
**x7952/y25584**, floor 11136, falls to **x10128/y23408**, floor 10080, then walks to
r20c17 on floor 11104 and back to the normal entry r50c31. The fall spans 3077.3
client units, below the shared budget of 3217.5.

The first trial stopped at takeoff with `fall_start_unsettled`, sent no fall and
restored the baseline. The lab runner now honors the existing vertical settling
timer (3064 ms in the repeat), confirms its exact origin, re-proves the fall,
uses the normal paced `step` with timed fall validation, and checks a fresh
server landing by XY **and floor**. The repeat landed at zero endpoint error;
a predicted jump reply alone did not count as success.

Next investigation: the first legal connection from the entrance's lower shelf
to the western upper staircase. A coarse r38c25 seed is misleading: the old
live body was on floor 5056 while a representative footing in that square was
12432. Keep exact fine coordinates and floors. The previous 32/64-unit phase
floods already bounded the lower component; repeating them is less useful than
identifying a specific boarding edge or a geometry/client predicate discrepancy.

## Tools and private evidence

```powershell
node tools/m59-node-jump-audit.mjs 515 --from-client-x 31232 --from-client-y 50688 --to r20c17 --json
node tools/m59-node-route-audit.mjs 532 --from r1c29 --to r23c30 --exact-walk
node tools/m59-node-path-test.mjs
```

The jump audit reports rejected arc bounds, wall IDs, missing centre floors,
actual and footprint heights separately, and integer-wire proofs. It opens no
socket. `m59-node-path-lab` adds explicit `--candidate-jumps 1..3` only for a held,
owned local replay trial; defaults remain walk only. The receipt's scope states
that an authored high-start success does not establish entrance access.

Use explicit owned config and authored scene, never a shared maintenance port:

```powershell
node tools/m59-node-path-lab.mjs --config <owned-local-config.json> --scene <vale-entry-scene.json> --to r23c30 --return r1c29 --out <private-evidence-dir> --quiet
node tools/m59-node-path-lab.mjs --config <owned-local-config.json> --scene <peak-upper-only-scene.json> --to r20c17 --return r50c31 --out <private-evidence-dir> --quiet --candidate-jumps 1
```

Private evidence: `C:/code/m59-lab/prod-deploy/substrate/replay-smoke/other-nodes-2026-10-06/`.

| File | What it proves |
|---|---|
| node-path-1791337204738.json | Vale first approach and return, 74,467 ms. |
| node-path-1791338477942.json | Vale repeat on final runner, 75,291 ms, observed sector state. |
| peak-upper-original-plan.json | Original planner refuses the same high-start objective. |
| peak-jump-audit-fixed.json | 174 raw proposals, 15 checked model falls; diagnostic stage before final search filtering. |
| node-path-1791338127553.json | Partial Peak first refusal: unsettled start, no fall packet. |
| node-path-1791338329191.json | Partial Peak approach and normal-entry return, 105,452 ms. |
| peak-entry-proved-search.json | Bounded entrance search remains short. |

All four native Vale/Peak trials restored their owned baseline. The shared shadow-mana
server and production fleet were untouched. Offline regression tests cover the
real Vale round trip, the lost high-takeoff proposals, void/wall rejection, legal
small rises, excessive rises, and the checked upper-stair plan.


## Validation

The full `npm run test:movement` run completed all 21 suites with **0 regressions**;
19 previously named baseline failures remain unchanged. The node path suite
passed 16 checks, fall trace 35, rail follower 151, cache-aware circuit 14, and
critic 131. The final jump-audit CLI was also run from the authored Peak upper
seed: 211 raw proposals, 10 model-proved, with explicit void/wall/span refusals.
Those candidate counts are distinct from the single native verified fall.
