# Underworld node investigation, 2026-10-06

Two quiet native trials from normal entry now verify the complete puzzle,
**+5 maximum mana bond and exit without jumps**, in 201 and 219 seconds.
Both retained 59/59 HP and independently confirmed node mask 0→128.

The Underworld node is a temporary **rip in space**, not a ManaNode object.
It requires the five-brazier puzzle, separate activation to bond, and then
stepping onto the central portal to return. This investigation uses an authored
normal-entry character on the owned held-native replay server; it does not
cause production deaths or alter production characters.

## Source and puzzle

Primary sources under `M59_ROOT/kod`: `object/active/holder/room/monsroom/uworld.kod`,
`object/passive/flikerer/bswitch.kod`, and `object/active/portal/corpnode.kod`.
Normal entry is r23c19. Braziers are 1=r4c7, 2=r2c23, 3=r20c29,
4=r31c15, 5=r20c2. Only an unlit switch activates. Each toggles itself and
switches two and three places ahead in the cycle: masks 13, 26, 21, 11, 22.
The reset starts with one or two unlit braziers, rather than a fixed sequence.

The runner reads fresh wire animations, rejects unknown/missing/duplicate
identities, solves using unlit switches only, and checks the actual resulting
mask after activation. All 32 states have a solution of at most seven activations.
Restricting the final activation to southern switch 4 still solves every state
within nine activations. The observed normal initial mask 27 uses 3,5,2,5,4.

All five lit calls PuzzleSolved and places the central CorpseNode at r16c16
for 60 seconds. Activation from within two squares on each axis grants
NODE_CORPSENODE (128) and maximum mana, with a distinct success tail,
`feel the course of magic flow`. Walking onto its square only teleports; it
is not evidence of bonding. Source return behavior chooses the actual corpse
when available, otherwise safety. The generic stone circuit now marks this
as a conditional puzzle and does not dispatch an ordinary meld errand.

## Measured movement failures and repairs

The first walking trial stopped at waypoint 4 while correcting protocol
x1363/y1617 toward x1360/y1616. Remaining distance was 3.162 with tolerance 3,
but walkFine forced a minimum eight-unit correction. Checked precise arrivals
now cap the step at the remaining distance. A narrow-corridor regression
proves the correction succeeds without widening the allowed corridor. Native
repetition passed this waypoint and reached the braziers.

The first completed puzzle bonded (+5 max mana), but the portal expired before
return. Its nearest activation-box approach was on floor 1844. Finishing at
switch 4 alone also failed: the switch's activation area contains several
levels, and the cheapest approach selected that same low valley. The measured
return from that point needed 126 checked waypoints; measured higher-floor
points needed 28–38. This is a terrain/time interaction, not an unsolvable
puzzle or evidence that ordinary teleporting melds a node.

The final-switch planner chooses a reachable fine point with a separately
checked short portal return. It prefers floors close to the portal floor,
then route distance, and rejects more than 45 return waypoints before lighting
the final switch. From the measured west-brazier position, the selected final
point is client x17408/y28736, r29c18 on floor 6400, with 28 checked return
waypoints. Its approach is longer (107 waypoints) but happens before the timer.
The runner re-proves the return from the actual confirmed activation point,
walks that connected route until within activation range, bonds, then continues
the same route onto the portal. It stops if the portal disappears.

`fineRouter.planWalkToPoint` retains the exact reachable fine endpoint instead
of replacing it with a representative point from a coarse square. All emitted
chords and rounded wire coordinates are audited using shared RoomGeometry.
City portals and the pre-existing HellPortal are excluded from approach paths;
central triggering is enabled only for the prepared return route. The replay
lab also distinguishes continuing an authored Underworld scene from a new death.

## Runnable tooling

```powershell
node tools/m59-underworld-node.mjs --mask 27
node tools/m59-underworld-node-test.mjs
node tools/m59-underworld-node.mjs --config <owned-config.json> --scene <underworld-entry-scene.json> --out <private-evidence-dir>
```

The CLI requires the owned isolated port 17959, verifies replay ownership,
holds keeper planning/watchdog, records every plan, wire endpoint, reply,
flame mask, fresh meld message and mana change, independently reads node bit
128, and restores the saved baseline. Optional `--initial-mask N` authors an
initial puzzle state for a new trial; it does not force puzzle completion.
`--stay` requests a bond-only trial. Exported `runUnderworldNode(session, opts)`
uses normal paced player moves/activations and requires an already-in-Underworld
session with exclusive movement control supplied by its caller. No ordinary
circuit promotion or production keeper integration is made here.

Private receipts and geometry probes are retained under
`C:/code/m59-lab/prod-deploy/substrate/replay-smoke/underworld-node-2026-10-06/`.
Authored scene, initial stats/loadout, quiet room and retained stationary lab
player are not a faithful replay of a production death. Normal-entry room-local
puzzle/bond/return evidence does not establish town travel or monster survival.

## Validation receipts

Two full normal-entry quiet native runs solved five and six switches,
bonded, and exited without a jump in **200,852 and 219,245 ms**. Maximum mana
18→23, node mask 0→128, 59/59 HP before and after, exit room 1011 in each.
About 17.8 and 17.4 seconds elapsed from the observed final switch response
to the confirmed return. Both native baselines restored. Masks 27 and 26
exercise one-unlit and two-unlit starts; other states have offline solver
coverage, not a claim of exhaustive native route validation.

| Receipt | Outcome |
|---|---|
| underworld-node-1791339431286.json | Initial precise-waypoint refusal before activation; baseline restored. |
| underworld-node-1791339954174.json | Puzzle and +5 mana bond; lower-shelf exit expired. |
| underworld-node-1791340354134.json | Southern switch still approached on the low floor; portal expired before bonding. |
| underworld-node-1791340636917.json | Higher-shelf route bonded and exited, but final lab position-read classified the expected room transition as an error. Not counted as a clean completion. |
| underworld-node-1791340883510.json | Clean puzzle, bond and exit, 200,852 ms; actual initial mask 27. |
| underworld-node-1791341142509.json | Independently verified initial mask 26, clean puzzle, bond and exit, 219,245 ms. |

The clean mask-27 receipt requested an authored mask 26, but that early setup
helper did not apply it. Its fresh flame evidence shows 27, and it is counted
only as a mask-27 run. Setup now separately verifies both administrative room
flags and observed client flame state before running. The subsequent mask-26
receipt confirms both setup reads and the full result.

Validation on integrated main: **22 movement suites, zero new regressions**;
19 named baseline failures remain unchanged. The suite includes 16 Underworld
and 17 checked-node-path assertions. Focused node recognition (48), stone census
(60), seven Underworld replay-continuation assertions, replay environment checks,
and 25 castle chamber regressions also passed. Tools index is current.

The implementation and report are merged to main; production keepers were not
restarted or deployed. Native execution used the isolated development code;
the integrated main differs only by the other session's three independently
checked castle farming/refuge files and documentation.

