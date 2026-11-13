# Vale and Peak node pathing, 2026-10-06

Vale's **spawn location** is now verified from **Marion's normal town spawn
all the way through the forest and back to Marion**, in one complete quiet
native run: **336.1 seconds, 12 normal map crossings, 59/59 HP throughout**.
The earlier two tests began at Vale's room entrance; they did not start in Marion.
Peak has **one verified upper-stair-to-node-to-normal-entrance trial**, 105.5
seconds, also 59/59 HP. Peak's entrance-to-upper-stair boarding remains unresolved:
that trial began at an explicitly authored high staircase point.

## Other node opportunities

| Node | Current evidence / gate |
|---|---|
| Victoria, Sentinel, Ancient, Badlands, Icky Cave | Existing promoted five-node circuit with connected quiet native evidence; not re-tested as a complete circuit here. |
| Vale of Sorrows, 532 | Marion r56c39 → exact spawn r23c30 → Marion verified in one connected native run; the Fey stone remains a faction outcome. |
| Seafarer's Peak, 515 | Upper-stair walk, one checked fall, node square r20c17, walking return to r50c31 verified. Normal entrance boarding is still missing. |
| Dreaded Caves of Ice, 750 | Previous investigation verified the big chamber approach and return; actual meld requires the yeti's mana gate. |
| Ukgoth | Relic of Qor, spoken words, opening window and game-hour gate. Existing conditional recipe; not a casual terrain-only acquisition. |
| Avar / Martyr | Faction swing / portal activation prerequisites; no new casual acquisition claimed. |
| Underworld | Separate already-in-Underworld brazier puzzle and timed rip; see [the subsequent investigation](m59-underworld-node.md). |
| Guest demonstration | Guest-only context; no normal acquisition. |

No new acquisition is auto-promoted into the circuit. Vale remains conditional;
Peak lacks a normal entrance approach. No activation, faction alteration, yeti
fight or production deployment was performed by these trials.

## Connected Marion approach and north-exit defect

The original two Vale tests began **inside room 532**, at the normal inbound
r1c29. They did not prove travel from Marion. The connected test now starts at
Marion's ordinary town spawn, **room 200 r56c39** (protocol x2528/y3616), and
uses ordinary `Session.travel(532)` without forced intermediate hops or further
teleports. The live router chose **200 → 534 → 533 → 522 → 521 → 531 → 532**.
It arrived at Vale's normal entrance and then walked to the exact source spawn
**r23c30, protocol x1920/y1472**, with 59/59 HP.

The first connected approach took approximately **149 seconds**, including
123 seconds of normal cross-map travel. The room-local route retained 44
checked approach waypoints and 45 return waypoints, with zero audit failures.
Its extra return-to-Marion check then exposed an ordinary exit failure at
532 → 531. Five bounded attempts exhausted the north exit without sending an
outward packet; this was not a failure to reach the node's spawn.

Measured at **r1c28, protocol x1824/y96**, the closest baked opening x1842/y96
has an outward target x1842/y63 whose diagonal clips **wall 296**. The slightly
farther x1888/y63 chord passes the existing complete collision proof. Reusing
an already-reached staging square and re-anchoring solely by distance erased
the alternate target, so each apparent retry used the same blocked chord.
The executor now prefers a candidate whose complete chord validates from the
actual position inside the existing boundary gate. Wrong-door exclusion,
integer endpoint proof, wall/height rules, and the atomic send-time recheck all
remain in place. An isolated native reproduction changed from zero packets
and exit exhaustion to a normal 532 → 531 crossing in **5.1 seconds**.

The repaired complete repeat returned by **532 → 531 → 541 → 542 → 533 →
534 → 200**, ending in Marion at r30c66. Normal travel took 117.8 seconds
outbound and 156.0 seconds inbound; the complete spawn-location round trip
including checked local walking and planning took **336,063 ms**. All sampled
health stayed **59/59**. Both local routes passed their audits, with zero
jumps. The north crossing took **1.9 seconds**, and the native baseline was
restored. This is **one complete connected round-trip proof**, plus the first
successful town-to-spawn approach whose return exposed the defect.

The first trial quieted only the initial graph path; its actual western detour
through 522/521 was not included. The complete repeat explicitly quieted those
rooms as well, and all actual outbound and return rooms were covered.

Connected testing is held in the owned **17959/17998** lab. The authored town
start preserves the normal geometry and passive scenery; quiet setup disables
monster generation and removes active monsters on both possible forest
branches. No faction/karma change, stone activation, production mutation or
additional mid-journey teleport is used. The baseline is restored after each
trial. This proves approach and travel behavior for the observed floor state,
not survival amid live monsters or actual Fey-node acquisition.

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
connected town travel were not tested by those original two room-local runs.

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

`--travel-to` uses the ordinary travel executor before the exact local node walk;
`--return-town` adds normal town return. Every actual crossing gets a fresh
position confirmation, and edge receipts retain the exact attempted target and
full validation refusal. `--quiet-rooms` covers alternate live routes beyond the
initial graph path. An arrived reply alone cannot verify the wrong final room.

Use explicit owned config and authored scene, never a shared maintenance port:

```powershell
node tools/m59-node-path-lab.mjs --config <owned-local-config.json> --scene <marion-start-scene.json> --travel-to 532 --to r23c30 --return r1c29 --return-town 200 --quiet --quiet-rooms 511,521,522 --out <private-evidence-dir>
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

## Connected proof receipts and final validation

Private evidence directory:
`C:/code/m59-lab/prod-deploy/substrate/replay-smoke/vale-from-marion-2026-10-06/`.

| File | Evidence |
|---|---|
| node-path-1791341741564.json | First normal Marion approach reaches exact spawn; extra town return exhausts Vale north exit. |
| node-path-1791342023596.json | Isolated recorded r1c28 reproduction: all five outward attempts clip, zero packets, baseline restored. |
| node-path-1791342139633.json | Same north-edge reproduction after repair: ordinary crossing succeeds, 5,107 ms including target confirmation, baseline restored. |
| node-path-1791342509209.json | Complete Marion-to-spawn-to-Marion native proof, 336,063 ms, all actual route rooms quieted, baseline restored. |
| movement-fixed-tests.log | All 22 movement suites, zero new regressions; 19 existing named baseline failures unchanged. |

The final node path suite passes **20 checks**, including fresh connected
arrival, actual hop evidence and Marion's coded town-exit graph. Collision
regressions use the real Vale doorway and runtime queue to reject its blocked
nearest chord and accept the fully proved alternative. The unrelated current
main standing-order changes also pass their 18 checks after local integration.
The previous validation section describes the earlier room-local work.
