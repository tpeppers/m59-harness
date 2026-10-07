# Ice Caves node pathing, 2026-10-06

Goal: enter room 750 from Druid Hills, reach **r25c20 in the main chamber**,
and return to the entry at **r46c25**, without killing the yeti or activating the
stone. The stone is r25c23; reaching a nearby square outside the chamber does not
fulfill the operator's approach objective.

## Defects and changes

The old coarse walk stopped at r30c30 with `no_ground_gained`. A finer route was
also unsafe to execute: waypoint decimation removed maze corners, while the flood
accepted clipped slides whose endpoints were not reproducible as new aims. The
old 208-waypoint route to r21c20 contained 33 refused chords. An initially cleared native
follower stopped at waypoint 36 near wall 392. That is a route-following baseline,
not a reconstruction of a death under fire.

`fineRouter(..., {exactWalk:true})` now searches using integer wire positions and
fully arrived movement traces. Compression preserves corners unless the mover
proves their replacement chord. It accepts the session's current geometry for
animated doors. Legacy declared-jump planners retain their clipped-slide repair
mode; each leg reports whether its emitted walk is actually proved. The ordinary
Ancient Place planner still finds the same three declared jumps.

`walkFine` checks a server-confirmed arrival after the final allowed step. Its
optional `exactArrival` mode honors the requested tolerance at narrow bends.
Existing broker calls expose these as `route_fine.exact_walk` and
`walk_to.exact_arrival`; `fineclimb --exact-walk` audits its plan and stops on a
failed waypoint. Route output coordinates are client units, while movement x/y
inputs are KOD protocol units. Use the shared conversion and shelf-aware
quantizer, not raw waypoint numbers.

Ice's first gate is a timing problem too. `icecave1.kod` opens sector 1 on `go`
from r24c10 or r24c11. Its 4.35-second animation consumes part of a ten-second
opening window. A native test that computed the route afterward spent another
4.6 seconds planning and failed at waypoint 3 as the door shut. The lab runner now
prepares a conditional route using the existing ceiling-door table on a private
geometry copy before pressing, then requires the normal server opening and live
collision validation. The return approaches the reachable chamber-side trigger
r24c11; r24c10 is outside the closed door.

Sector 2 still requires killing the yeti. Previewing sector 1 does not open sector
2 on either the real server or the private planner when the observed mana gate is
closed. This work does not change jumping physics or publish new declared jumps.

## Reproduce and inspect

Offline, without a socket or roster:

```powershell
node tools/m59-node-route-audit.mjs 750 --from r46c25 --to r24c10 --exact-walk
node tools/m59-node-route-audit.mjs 750 --plan <saved-plan.json> --json
node tools/m59-node-path-test.mjs
```

Use an explicit owned native replay configuration and an authored scene in the
existing replay format. See [native lab setup](m59-death-replay.md). No fleet,
character, maintenance port or production server is selected implicitly.
The runner resets its owned baseline before and after a trial and pauses keeper
planning for movement-only testing. It does not heal during movement, attack or
activate a node. Explicit `--quiet` uses the existing `noMonsters` scene option to clear monsters
and keep generation disabled for the trial. Without it, setup clears unlisted
monsters but normal generation resumes after release. `labScenery` retains items;
it does not make a room quiet. Neither option alters collision or room scripts.

```powershell
node tools/m59-node-path-lab.mjs --config <owned-local-config.json> --scene <scene.json> --to r25c20 --via r24c10 --door --return r46c25 --out <private-evidence-directory> --horizon-ms 900000 --quiet
```

The receipt contains the replay adapter's server/source attestations, geometry
plans, fine and wire chord audits, waypoint replies, actual poses, floors, health,
normal door openings, approach/return endpoints and baseline restoration status.
A healthy observation window alone is not success: require `result.arrived`,
`approach_verified` and `return_verified`.

## Evidence and limits

Private evidence is in
`C:/code/m59-lab/prod-deploy/substrate/replay-smoke/ice-node-2026-10-06/`.

| Receipt | Result |
|---|---|
| `coarse-baseline.json` | Original coarse walker stopped with no ground gained. |
| `fine-baseline.json` | Original fine route stopped at waypoint 36. |
| `plan-chords-audit.json` | 33 original emitted chords not proved. |
| `fine-fixed-*.json` | Repaired maze leg reached r21c20 alive; outside main chamber. |
| `node-path-1791334095228.json` | Float-route audit rejected four wire chords before moving. |
| `node-path-1791334396567.json` | Door opened normally, but post-press planning exhausted its window. |
| `node-path-1791334892946.json` | Door-start approach to r25c20 and walking return to r46c25 succeeded, 243 seconds, 59/59 HP; spawns permitted. |
| `node-path-1791335203484.json` | Entrance-to-chamber succeeded; respawned yeti killed the character on the return at r20c15, after 249 seconds. |

The door-start success includes the full return maze, but starts at the door.
Keep that count distinct from an entrance-to-chamber-to-entrance run. Initial
removal is not continuous suppression: the first complete run allowed spawns and
failed survival despite reaching the chamber. It recorded several yeti hits on
the approach, and lethal hits during return. This is positive evidence that a
working geometry route alone is insufficient for a 59-HP body with movement-only
control. There is no claim of reliable survival with a yeti, snow rats or other
bodies in the route. A useful next stress test inserts a known body at a narrow bend and
checks that exact arrival stops promptly rather than proceeding from a wrong
point. Ice is conditional and has not been added to automated node acquisition.

The new offline suite covers corner retention, wire routing, last-step confirmation,
server corrections, cancellation, room changes, wrong-shelf landings, exact arrival,
private door previews, the independent mana gate and the inside return trigger.
The node circuit checks pass, including Ancient transit. The default Ancient
three-jump route also bakes completely with zero unvalidated edges and passes
1,470 retraced lattice steps. Eleven new checks, 10 existing ceiling-door checks,
151 rail-follow checks and 17 tour-policy checks pass. The portable full movement
run executes 21 suites with zero regressions against 19 named existing failures. Full movement checks
retain their named existing failures. With this machine's shared private walk logs,
the map-567 exclusion assertion fails on **both unchanged main and this repair**;
see `routing-main-matching-evidence.txt` and `routing-fixed-idle.txt`. An isolated
original checkout without those optional logs passes. Keep portable fixture runs
and local-history runs distinct; do not mark this as a new Ice regression or hide
it by adding a new global known-red entry.
