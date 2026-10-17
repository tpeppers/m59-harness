# Walking to Brax

`walk-to-brax agents=a,b,c` is a FleetScript for one through 25 automated
characters. Its destination and success condition are **alive in room 827,
Ancient Graveyard of Brax**. The castle interior is a later errand.

Start the fleet REPL in the checkout holding the fleet, with an explicit
`M59_CONTROL_URL` and `--fleet`. The public script is
`tools/fleetscripts/walk-to-brax.mjs`; its route and coordination are in
`tools/m59-brax.mjs`. `steps()` generates/checks the local approach rail and
does not move a character. The real run takes the normal FleetScript keeper
leases, retaining survival with the keeper.

For the local test fleet in this worktree (PowerShell):

```powershell
$env:M59_CONTROL_URL='http://127.0.0.1:8981/'
node tools/m59-fleet-repl.mjs --fleet brax-test
```

Then enter `walk-to-brax agents=braxtest01,braxtest02,braxtest03`.
The shared local game server is 127.0.0.1:15959; its dedicated test dashboard is
http://127.0.0.1:8982/fleet. The broker uses the repository's normal control-URL
resolution, including an explicitly required URL when the checkout demands one.

## Route

1. Ordinary travel to the Sentinel (589), then the eastern Ancient Place
   entrance (579). Reuse the tested mana-node rail's cliff climb, first fall,
   and the ascent after it.
2. Branch near r39c37. A fine rail reaches the southern takeoff at r32c55
   (adjacent lane r32c56). The operator's approximate r39c55 is empty in this
   geometry; it must not be used as a square-center destination.
3. Fall onto r25c55/r25c56, with platform sector 3 down at KOD height 250
   (client height 4000). Board into assigned grid stations and gather.
4. Pull the center lever once, then each corner lever once. Divide the four
   corners into nearby jobs for the available members. Confirm the switch message,
   allowing a delayed message or the final observed platform movement.
5. Wait the full ascent and validate the observed heights: sector 3=800,
   sector 4=510. Follow the north aisle around the center spire, then fall
   from r15c55/r15c56 to r8c55/r8c56. Form two half-square-spaced
   departure queues. Each traveler continues along a terrain-proved north
   corridor through the actual eastern crossing into578 while followers advance
   into clear gaps. The exact r7c56 center is wall-blocked; the queued egress
   planner uses reachable integer fine points on the correct shelf.
6. Fine route to r1c62 and cross north into the eastern section of 578.
   Route to the eastern mouth near r27c50, then cross into 826.
7. Follow the winding cavern to the real east exit at r19c44 and cross into
   827. The locked eastern squares near rows 3–5 are a separate component.

Fine points use the existing 1024-unit client/BSP convention and are
converted with `m59-finepos.mjs`. Each new fall remains a declared running
fall, checked by the existing timed gravity, wall, body and step predicates.

## Cohort preparation and the cliff crossing

The public script acquires every selected member's ordinary keeper leases
before staging. It can share food already carried by selected fleetmates,
retaining a meal with each donor, then eat normally for running vigor. It never
grants food or vigor. Small checked walks move selected crowd members into
clearer positions; other players and creatures remain collision obstacles.

A resumed approach uses the confirmed body's actual shelf and the matching
walking leg. Nearby characters can join a declared takeoff only after a full
ground and timed-flight proof. The reusable `m59-crossing-queue.mjs` endpoint-keyed gate serializes
fine alignment, the first cliff fall and landing clearance. The next character
waits while the previous crossing remains occupied. Every packet retains normal
wall, body, gravity, floor and ownership checks. A dead driver can release a
stale reservation; its body remains an ordinary obstacle. Atomic journals live
in `m59-shared-journal.mjs`; forward gap and clearance planners live in
`m59-rail-traffic.mjs`. These helpers accept geometry and named fine points,
without a Brax room assumption. The Brax script supplies its route and lift rules.

Long road journeys use ordinary background travel and confirmed observations
within the original deadline. A subsequent road leg waits for the preceding
job's cleanup and refuses a foreign controller's job. The order puts the character in idle mode and disables town errands while
travelling. Travel clears the room assignment at intermediate and destination
rooms, preventing an old stationary enchantment policy from interpreting the
arrival as a new caster post. A later farming order must explicitly assign827
and restore the intended supply policy. Each journey has a 30-minute
budget, including legitimate waits for up to several lift cycles.

## Lift timing and shared batches

`kod/object/active/holder/room/monsroom/g9.kod:17-53,181-230,306-322,422-475`
defines the platform, working levers, height range and speed. Stock
`clientd3d/roomanim.c:487` animates KOD height units per second:

`(800 - 250) / 15 = 36.666… seconds`.

The route waits **37,667 ms**, then checks the current server-observed sector
heights. Observing a destination packet alone does not skip the wait.
`m59-moving-platform.mjs` applies observed floor changes to the same collision
geometry and installs a matching, offline-generated coarse movement mask.
The 256 endpoint combinations are fingerprinted against the shipped geometry,
sector IDs and height table; unknown heights or a fingerprint mismatch keep
observed fine floors but close the coarse mask. Runtime sector packets never
synchronously rebuild the whole room. Sector 10 is a ceiling, not a floor.

The lift stays solved for 120 seconds, then descends. The reset also locks
the levers for another 120 seconds (`g9.kod:328-376,409-417`). A completed
batch reserves the mechanism until **361 seconds after its recorded raise**.
`ResetLeverStates` calls `SwitchLever`, which synchronously calls
`SomethingChanged`. While resetting all five down levers, this can satisfy the
puzzle again and schedule a second reset. Its later `ActivateLevers` callback
runs six minutes after the original solve and locks the corners again. Starting
at the apparent four-minute rearm can therefore lock the final lever mid-run.
The server-model regression reproduces the observed successful first three
corners followed by a stuck final corner.

A new group also requires the full observed reset baseline: sectors 2/3=250,
4=540, 5–8=200 and 9=510. Without a known previous solve or touched timeout,
that baseline must remain observed for 241 seconds. Each pull requires the
expected group phase and visible floors: the center starts from the reset
baseline; corners require a confirmed center pull, raised center/outer spires
and a lowered platform. An unexpected state stops before activation. Failed
partial puzzles wait through five minutes from the last possible touch plus
the two-minute rearm. An untouched cancelled boarding group adds no cooldown.

An endpoint-keyed journal under the shared evidence directory,
`brax-groups/`, lets separate callers join one 60-second boarding window.
Admission closes at 25. Each character controls only its own movements and
assigned levers; the leader operates the center. An atomic short-lived
filesystem mutex protects journal changes across processes. No socket work
runs under that mutex. Ambiguous ownership or unreadable state fails closed.

Room texture replay and pillar lights can impose the existing temporary
collision guard. The rail follower and platform walker wait at the same aim,
bounded by the route deadline, and retain cancellation, room-change, wall and body
refusals. An explicitly body-blocked serialized approach can wait up to ten
minutes at the same aim, allowing a preceding group to finish the lift reset. They never advance through refused aims.

On the three onward rail legs, an interruption explicitly attributed to a
keeper survival action may retry at most twice. The route waits for at least
90% health (or its higher requested floor), no active survival decision, and
eight seconds without further health loss, then re-cuts from the actual
position. Death, changed rooms, geometry failures, and unrelated cancellations
remain failures. This is ordinary movement recovery, without healing or placement.

## Evidence and limits

Local trials use only new `braxtest01`/Alfa, `braxtest02`/Bravo and
`braxtest03`/Charlie on fleet `brax-test`, broker 8981, sharing the existing
native movement server at 127.0.0.1:15959. Each has a keeper and verified
creation attributes. Administrative placement and health grants occur only
in the trial setup, before the measured route. The public script imports no
administrative tools.

Detailed movement and objective receipts are under `substrate/brax-attempts/`.
The early failures remain there, including the delayed final-lever message
and the room-entry animation refusals. The final complete trial on 2026-10-14 PDT (2026-10-15 UTC) succeeded **3/3**:

| Agent / character | Full route receipt ID | Alive arrival in 827 (UTC) |
|---|---|---|
| braxtest01 / Alfa | braxtest01-1792027915424 | 01:41:21 |
| braxtest02 / Bravo | braxtest02-1792027923653 | 01:42:05 |
| braxtest03 / Charlie | braxtest03-1792027931834 | 01:41:39 |

All arrived at r5c2 with 151/151 health, with no mid-route administrative
placement, healing, death recovery or survival retry. The measured route began
at the actual eastern Ancient Place entrance, r38c74, after setup; the normal
road travel to that entrance is composed from the existing travel tool. They
shared one batch and exactly five confirmed lever pulls. Route build f7c9f159,
source hashes in `substrate/brax-attempts/full-final-build.json`, and a compact
summary in `full-final-result.json` identify the successful trial. Later code
changes use the standard broker-URL resolver and handle a transient Windows
mutex delete-pending refusal; the route geometry and sequence are unchanged. The trial retains normal monsters;
it does not disable generation or remove hostile creatures. The operator permits
restoring dead test characters to a previously reached checkpoint with full
health and vigor, but any such recovery is recorded separately.

The layout, queues, assignments, and paths around 24 parked bodies are checked for 25 members; a three-character live
trial is the group-scale check. A 25-character live convoy and arbitrary
hostile crowd tolerance require their own evidence. A blocked or interrupted
character must produce a failure receipt rather than an arrival claim.

Validation: the movement runner completed 49 suites with zero regressions
(existing named baseline failures remain). Focused checks also cover unrelated
lever messages, keeper survival recovery gates, and the Windows mutex retry.

## Full-shadow follow-up

The 2026-10-16 full-shadow trial ended **1/24**, with no recorded deaths.
The original dispatch and three corrected retries retained actual positions
and all failures. Three lift ascents occurred; the final batch carried seven,
but only Rizzo reached 827. Farming did not start because a majority did not
arrive. This supersedes any fleet-scale inference from the earlier 3/3 trial.
See [full trial results](m59-brax-shadow-trial.md) for failure stages and limits.


## Convoy reliability work in progress

The renewed shadow trial keeps the same 24 clones and their cumulative losses.
After the cloning cutoff, it uses ordinary movement, recovery, food, crafting
and trades only. The production broker remains read-only. Earlier setup-time
placement permissions do not apply to this trial.

The first fresh all-24 departure from Castle Victoria on October 16 PDT
(October 17 UTC) completed only 2/24: Pepe in 13m04s and Lew in 21m17s, in two
separate lift groups. It failed qualification. Scooter died to a black spider
in Ancient Place during that attempt; Pepe had previously died to a troll in
Ukgoth while returning to Victoria. These are travel/return losses. No farming
hour has started. Historical arrivals accumulated during debugging are not a
fresh all-character success.

Reusable convoy pieces now live outside the Brax puzzle:

- `m59-road-journey.mjs` follows one owned ordinary journey, including its keeper
  recovery/resumption. An ended job can publish `traffic_wait` only when every
  exit refusal was an explicitly unsent body collision. A new request waits
  for a fresh body-aware path to an exit trigger; health refusals wait for the
  actual requested health floor. No parallel driver is started.
- `m59-rail-traffic.mjs` plans bounded crowd clearance and forward walking-leg
  gaps against the actual BSP and bodies. Forward movement stays on the same
  checked leg, preserves the floor fence and next-body buffer, and is still
  validated by the native mover before each packet.
- `m59-crossing-queue.mjs` reserves short approaches and their landing clearance
  across CLI processes. A waiting follower must acquire atomically after waking;
  observing an empty gate gives no movement authority. Live owners are retained.
- The strict rail follower yields to an observed keeper recovery. After an
  explicitly unsent traffic refusal, it may re-plan a takeoff from the confirmed
  original shelf within the existing deadline. A transport timeout is not retry
  permission. Timed neighboring takeoffs retain full flight validation when the
  mover considers an alternate lane.

Recorded real-map crowd tests and socketless real-Session movement regressions
cover these mechanisms. They do not establish 24-character live reliability;
that requires a fresh Victoria departure with all 24 individual successes and
new room-827 objective receipts on one unchanged build. Only then does the
separate real-hour hammer-farming measurement begin. Individual durable native
postmortems supplement sampled counters and the fleet ledger for its death audit.


Recovery trips have their own native lifetime marker (`recovery_travel`). Starting
one cancels the old movement generation even when its owner is a fine walk rather
than a road journey. Script fine moves and jumps wait for that protected trip;
ordinary operator overrides remain available. The Brax entry/cliff controller can
recognize the exact keeper recovery cancellation even after the trip ends, then
continue from the actual position using only its original remaining deadline.
This prevents a provisioning trip and a cliff follower steering the same body.

Takeoff refinement also obeys the public verb's one-square source neighborhood
and its straight-lane body clearance. An arrival trace that slides around a body
does not prove that straight lane is usable. The recorded two-character case
checks the physically earlier character's native flight first, followed by the
waiting character after it clears.


The fine walking legs now execute inside each keeper (`walk_rail`), using the
ordinary paced walker at its normal 48-unit initial stride and 80-unit ceiling.
The CLI still owns declared jump admission. It releases that short claim once
an ordered observation confirms landing clearance, while the keeper continues
the rest of the walking leg. Body waits and forward-gap planning happen locally;
there is no broker round trip or ordered room read for every walking aim.
`movement.rail` reports the current aim, last movement time, body blocker,
waiting phase and completed state for locating jams. Packet collision, center
floor, cancellation and survival ownership checks remain in the ordinary mover.
A fully boarded requested cohort starts operating the lift immediately; the
60-second gathering window remains the cap for arrivals that are still behind.
These mechanisms also apply to other checked walking rails.

Future shadow construction reconciles known skills and spells, including removal
of starter or stale abilities and restoration of source proficiency values. The
tracked build stage runs `m59-shadow-abilities.mjs` before play and requires a
second authoritative readback. It fails on unresolved source names, unread lists,
or mismatches. This is a construction operation; it was not applied to the 24
existing Brax trial clones. Their recorded reproduction limitations remain.

Use `node tools/m59-rail-traffic-report.mjs --fleet <fleet>` for a read-only
snapshot of active native walking queues. It follows reported body-blocker chains,
labels cycles and moving fronts, and leaves unidentified stalls explicit. It reads
cached states, so the diagnostic does not inject position reads into moving keepers.
Detailed postmortems remain the primary loss evidence; the ESM writer also now
appends its intended cumulative `deaths.jsonl` summaries.

Boarding retains the shared landing claim only until an ordered observation
proves a half-square of clearance on the lowered platform. The rider keeps walking
to its reserved station while the next rider boards. Parking completion is still
required before lever operation, and a failed observation never releases early.


Departure preparation releases each clear traveler independently, including clear
travelers in another room while a crowded room is still being spaced. The staging
coordinator never moves a released character again. Low-vigor preparation starts
below 80 and aims for 120 using ordinary carried food or fleetmate trades; it no
longer holds the whole cohort to raise every traveler to 160.

After their assigned corner levers, workers stay on their platform stands during
ascent. They do not cross one another to return to parking stations. Once the
normal ascent wait and observed height checks pass, they join the two departure
lines and continue through the upper landing independently. Positively returned
point-walk confirmation failures use bounded own-body re-observation before
continuing; an ambiguous transport failure does not authorize another move.

Waiting crossing callers poll cached, identity-checked keeper views. These are
eligibility hints only: taking the short crossing claim still requires a fresh
ordered position and a new full flight proof before movement. This avoids each
waiting character repeatedly requesting a complete game-room read. The native
read-only `movecheck` endpoint also accepts named fine `x` and `y`, with explicit
`slide`, `fall` and `timed_fall` flags. Brax flights require its exact live native
validation before calling the ordinary jump verb; the packet sender retains its
own final collision check. Unsent native refusals include the actual validation,
and scene captures retain the controller's vertical uncertainty for reproductions.

Receipts distinguish `admitted`, `aboard`, `lift-raised` and `lift-validated`.
An admission group that aborts before raising the lift is not an elevator trip.
These changes have focused offline regression coverage; they do not by themselves
establish a live migration duration or successful all-24 qualification.


Platform point walks also yield to a positively identified keeper recovery and
continue only after its ordinary recovery finishes within the route budget.
Movement cancellation no longer resurrects a previously yielded or ended survival
intent. Explicit new danger can still create a recovery, and an active hurt
recovery remains protected across a script claim. This prevents an old inactive
intent from repeatedly interrupting a healthy traveler.

Parking selects the nearest clear reserved grid station rather than the first
free station at the far side. A failed request is fenced at admission, so its late
travelers cannot silently start additional small lever runs after the rest of that
request has stopped. A new request still needs full observed puzzle readiness.


The raised-platform departure queue advances progressively along each straight
lane. `planLineQueueAdvance` proves the free prefix behind the nearest unfinished
predecessor using live bodies and the same floor and collision trace. A follower
may fill that prefix while its leader walks, jumps and clears the northern
landing. It need not remain at its original station until all earlier riders
finish. Each native advance retains the script owner and movement generation.

The native jump verb owns its standing posture. It waits out an actual cast
hold, stands only when the cached posture requires it, and checks cancellation
before sending. Brax no longer pays the general rest tool's stat refresh before
every flight. The lift's stock reset begins 120 seconds after the puzzle is
solved, leaving roughly 82 seconds after the validated ascent for departures;
more waiting time cannot repair a queue that misses that window.

A failed fine walk now records its actual stride, packet budget, last step and
whether avoidance includes the origin. Short island chords retain at least
eight packet opportunities within the original route deadline. These diagnostics
preserve returned failures for reproduction without relaxing geometry or bodies.


The captured Winding Caverns failure at KOD `{x:584,y:576}` was reproduced with
real Session walking and the real Pacer: a normal create-food cast suppressed
all twenty attempted move submissions, which were misreported as a blank geometry
refusal. `stepFine` now labels a held submission explicitly. `walkFine` waits for
the actual cast before posture and movement, retains client/room/generation guards,
and does not spend a step or stall attempt when a hold begins at the send boundary.
A bounded wait returns a visible casting hold if it outlasts ten seconds. It does
not break the cast or override collision. The fixture and before/after regression
also cover cancellation while waiting. Fine-route failures retain the exact walk
request and the physical observation used to plan it; native unsent steps retain
their actual validation instead of only an ambiguous refusal label.


Concurrent rail observers share one in-flight read-only keeper-band discovery
per fleet. A completed result is never cached across later discoveries, so a
handoff's replacement PID must be rediscovered. An empty initial scan is retried
within the existing attempt/readiness limits, before any addressed action is
possible. This prevents a full cohort from issuing one complete band scan per
actor at the same instant. Keeper identity conflicts still terminate immediately.


The repeat trial records each character's actual starting health at Castle
Victoria and uses the public route's 90% health threshold. Exact full-health
equality is not a qualification requirement. Ordinary preparation reads retry
transient transport failures through the same identity-checked observer; they
never repeat an ambiguous movement write. Concurrent band-scan sharing also lives
at the common `scanKeepers` boundary, so other cohort callers get the same benefit.


A new arrival extends a still-open gathering window by sixty seconds, capped at
three minutes from its creation. A complete requested lift cohort leaves as soon
as everyone is aboard. Characters already in room 827 or able to return locally
from 826/833 do not hold that lift barrier. A closed window is never reopened.

Platform aisle pivots are guides. If a parked rider occupies one, the detour
planner proves a complete body-clear route to the actual lever/station endpoint,
retaining the floor fence, instead of insisting on reaching the occupied guide.
The captured center-to-NW worker deadlock is an offline regression fixture.

Long native rail requests use one core-HTTP POST with the caller's explicit
absolute deadline. This avoids fetch's implicit five-minute response-header
limit. A lost reply never triggers a second action; failure evidence retains the
child transport error and actual native activity, and cleanup cancels only a
positively observed operation owned by the failed caller. Foreign movement and
keeper recovery remain protected.

The shared native movement queue also preserves a casting pacer's explicitly
suppressed result as `casting_hold`. This covers a cast starting after a jump's
initial proof, as well as ordinary walking. A declared fall may continue only
from a newly observed, fully re-proved flight; the held attempt emitted no packet.

Fine-route recovery reads body, lease and recovery stage from the same current
native observation. Broker cancellation and explicit foreign leases still stop
the controller. An interrupted rest may resume only after the same owned body
is observed healthy; otherwise a live ordinary keeper recovery retains the
original leg deadline. Failure receipts include the recovery stage, lease and
body instead of discarding that evidence as a generic controller failure.

Preparation phases use separate cohort keys and release each cleared traveler
independently. The captured Cragged return-entry stack has a real-geometry
regression: eleven ordinary clearance walks release twenty-two selected bodies.

Native boundary candidates retain their structured edge condition. An injected
baked anchor must satisfy that condition before inheriting the branch crossing.
Ancient Place has two north branches to map 578: substituting western r1c17
into the eastern col>20 candidate mixed an unrelated staging square with its
eastern fine crossing. The regression keeps the compatible western anchor and
executes a complete validated eastern crossing from the prepared public exit.
The public fine approach remains responsible for reaching that exit point.

### Native departure lanes (2026-10-17)

The coherent actual-position trial qualified-current-cohort-01 reached Brax with 17/24 characters. One lift carried seventeen riders; sixteen cleared the north landing. The last rider missed the solve-plus-120-second reset after repeated zero-step advances and sideways takeoff alignment. Six waiting travelers inherited that failed group receipt. This was not an all-Victoria timing benchmark, and farming had not started.

The actual last rider receipts and validated floor state are retained in tools/fixtures/brax-north-departure-reset.json. The parent had planned advances from a cached own-body snapshot and gated departure on earlier journal updates. Native movement had already reached several repeated targets.

Departure now uses one native checked walking order per lane. Opt-in stayInLane walking takes the currently collision-clear straight prefix, rechecks the actual native body, and waits locally when occupied. It never fans sideways. Final-send collision, ownership, pacing and floor guards remain. Native takeoff eligibility requires a proved flight from the actual body. An occupied, terrain-proved flight waits instead of choosing another takeoff through the adjacent queue. Leaders continue through landing clearance and onward routing while followers advance.

The original socketless departure test removed bodies after short landing clearance; its earlier timing excluded the onward bottleneck. The revised m59-queued-takeoff-test.mjs retains twenty-five real Session bodies through their actual crossing into578 (described below). Offline timing excludes live network latency and assembly and is not evidence of a sub-five-minute fleet migration. Integrated collision checks remained 427 passed / 0 failed.

Repeat preparation uses ordinary roads through the Twisted Wood and Ukgoth to room589, then the public cliff/lift route. A proposed reverse fall was rejected before any live attempt: reset raises the north landing to 8640, while its reachable approach lip is 8160. The isolated fall from the higher point passes physics, but that takeoff cannot be reached by walking from the returning party. Its provisional declarations were removed. Preparation and fresh outbound timings remain separate.

### Completing the correct entrance and joining a busy rail

A Temple801 traveler can enter Ancient Place at western r41c1. Stopping every road journey as soon as room579 appeared canceled that traveler before its route to589 had finished. The fine approach then correctly refused the mandatory boundary exclusion at r42c1. The ordinary road completes that departure legally: the captured western entry crosses to589 and reenters Ancient Place at its eastern cliff entrance in27 validated Session packets. Brax road travel now completes that entrance; an already western-edge traveler also takes the ordinary road through589.

A separate crowded-head failure occurred after the approach had already reached a valid rail connection. The final captured positions actually pass the old numeric boarding test: the mistake was continuing to demand the exact occupied head after joining. checkedIslandWalk now accepts an explicit stopWhen predicate and returns connected with targetReached:false when a fresh body read proves the caller's alternative connection. Brax uses this to hand over to its rail follower. Optional geometry-aware strict boarding also permits an ordinary step-height difference only when the actual-to-authored connection passes the complete ground trace and the authored floor still matches live geometry. Walls, lower gullies and live send-time body collision remain barriers.

The room827 arrival command now clears assigned_room while setting idle. Previously it assigned827 as a post; Loial's existing room-enchantment policy interpreted that as a new stationary caster post and immediately walked toward r5c10. A daemon skeleton killed the20-HP character about7seconds after a successful arrival, enroute at r6c8. This was a pre-farm loss. Clearing the travel destination prevents that unintended post without rewriting the character's enchantment policy. An experimental group parking allocator failed its tests and was archived without ever being used live.

The coherent current-position continuation records already-present verified arrivals separately from new arrivals. Each already-present character needs its prior ordinary public arrival receipt, all24 public calls must succeed on the frozen current build, and every initially absent character must have a new arrival. Already-present characters do not enter arrival-time percentiles. This avoids extra exposure from repeatedly returning successful travelers solely to reset a benchmark. A full24-character Victoria-to-Brax speed benchmark remains unproved.

### Continuous north egress and shared passage flow

The next continuation exposed a different jam. One lift carried twelve riders;
five stopped beyond the north landing. The old socketless test removed bodies
as soon as a short landing-clearance walk finished, hiding the onward corridor.
The replacement retains every body until its actual declared crossing into578.
Twenty-five real Session movers complete that socketless scenario in about27s
and1002 normal movement packets; this remains an offline corridor measurement.
The captured five-person post-reset jam also clears with three ordinary spacing
walks and all five legal eastern crossings.

A coarse connected passage zone had treated every other occupant as opposing
traffic. An opt-in checked convoy now shares admission only for explicitly
selected characters, the same controller key and the same destination. Atomic
claims retain each member separately. Unknown players, different flows and
ordinary callers retain exclusive admission. Every packet still checks bodies,
floors, movement ownership, concentration and pacing. The cross-process test
covers shared claims, opposing traffic, human occupancy and individual releases.

The native egress follows its proved path continuously, advancing into currently
clear prefixes. Short protocol corner connections remain on the proved segment;
ordinary descending motion waits for its observed height range to settle when
necessary. A bounded finer lattice phase avoids a false disconnected verdict
from a narrow lip. Ordinary crowd spacing also proves its terrain return.

The north egress keeps the exact published eastern exit selected through its
ordinary crossing. A confirmed body already near that opening must not be sent
back through a coarse staging walk or an unrelated baked room-traversal rail.
The reusable prepared-stage check requires the same staging cell and a complete
terrain connection to the opening; predictions and wall-separated poses refuse.
Outward movement retains its normal collision and branch validation. Crossing
retries require a positively unsent body refusal and spend the original budget.

Road-to-fine handoffs now confirm the actual destination position. Native rail
failures retain native-walk recovery evidence; only a living exact-run keeper
preemption under the current movement lease permits ordinary road resumption.
Idle travel clears its post assignment in intermediate rooms as well as at Brax,
so it cannot accidentally turn an original caster policy into a new posting.
All24 live reliability and the requested farming hour remain separate checks.

The live convoy must resolve selected player names through the raw object's
nameRsc resource; the room projection's resolved name is not present on the
incoming client object. Both integrated scenarios now use that raw wire shape.
After the correction, all five previous live north holdouts reached827. A first
fall also accepts a confirmed body on the bounded, terrain-connected platform
instead of requiring the one original aim cell. Predictions, other rooms,
wrong floors and disconnected components remain refusals. Landing observations
record actual changed positions for subsequent diagnosis.

The next live group reached the platform but stopped after the center and three
corners. Its remaining20-HP worker had full health and78 vigor; treating that
small deficit below the resting cap as urgent recovery preempted its corner
walk. The incomplete puzzle left no eligible map-exit refuge, so it repeatedly
replanned while the other workers timed out. Healthy fine-route travel now uses
the existing rest=false road doctrine while normal road vigor remains. Native
pending recovery can complete under that same narrow condition. Wounds,
exhaustion, ailments, post-death recovery, farming, stopping and foreign or
protected control retain the usual recovery behavior. The captured transition
runs through the real native survival method in the regression.

### Corrected current-position qualification

The next frozen-build continuation completed all24 public-script calls without a new death. Eleven characters began in827 with prior individual ordinary arrival receipts; thirteen newly entered827. Nine needed the lift: six rode the first trip and three late cliff travelers rode the second. Both trips completed the center/corner sequence, timed rise, observed height validation and north exit. The20-HP lever worker completed ordinary travel with the corrected vigor-rest decision.

For the thirteen new arrivals, elapsed time from the common mixed-position departure was p50 230.670s, p90 670.339s and maximum692.974s. The second group waited for the source-derived puzzle reset. These are continuation measurements, not a fresh24-character Castle Victoria benchmark or a claim that full-fleet migration meets the five-minute goal. Earlier failed attempts and six pre-farm deaths across four characters remain in the trial evidence.

Post-qualification hammer preparation uses ordinary carried spares, Create Weapon and verified character trades. Farming begins only after every living traveler is actually in827 with an equipped hammer; the requested real hour and its deaths are measured separately.

### Completed shadow farming hour

All 24 had actual equipped hammers and were alive in room 827 before accepted farming orders. Each accepted order received a real 3,600,000 ms window; the first began 2026-10-17T09:35:57.225Z and the last ended 10:35:59.555Z. The runtime remained frozen. The first dispatch attempt was entirely refused by broker validation before any keeper push; its rejected records were preserved, the private payload corrected from room_enchant:{enabled:false} to null, and the actual clock started only on confirmed corrected orders.

The audited hour recorded **four distinct characters and five deaths**: four daemon-skeleton deaths in room 827 and one additional troll death in map 578 while returning after death. All five have individual primary postmortems. Six earlier setup/debug/travel deaths across four characters are excluded from this farming count; no administrative rescue, grants, world changes or replacement clones were used after the recorded construction cutoff.

There were 30 credited kills across 16 characters: 24 narthylworms and 6 daemon skeletons. The five Qor casters received narthylworm primaries and credited 8 worm kills; the other characters received daemon-skeleton primaries and credited 6 daemon kills plus 16 worm kills. These are per-character credits, which may be shared, rather than unique world-monster kills.

Presence and provisioning materially limit the mortality interpretation. Mean sampled online presence in room 827 was 50.66 minutes, with a 3.06 minute minimum. Hammer-equipped online presence in room 827 totaled 1,153.01 character-minutes out of 1,440 ordered character-minutes. Ordinary mana/rearming gaps included about 14.87 minutes for one traveler and 32.02 minutes for another. Recovery, safe-wall holding, ordinary town trips and stalled return journeys consumed time; this was not sixty uninterrupted combat minutes for every character. Exposure uses nominal 15 second samples with a 45 second carry-forward cap.

The public migration script completed the corrected continuation, but default farming recovery travel does not automatically run that specialized cliff/lift script. Several natural post-death returns stalled outside room 827. The test therefore preserves both the successful migration result and the limitations of unattended farming/return behavior. Full 24-character Victoria-to-Brax timing remains unmeasured, and a sub-five-minute p90 is not established.

Post-hour regressions exposed an overly broad finer-lattice fallback: enabling it on every ordinary body detour prolonged departure-candidate searches and prevented completed refusal caching. Refinement is now explicit for the new road-gap, rail-end and declared-landing callers; existing departure defaults are retained. The captured narrow-gap proof still passes, and the pocket/deviation regressions pass 13/13 and 14/14 respectively. This post-measurement compatibility correction changes no collision rules; the live trial hash record remains the original measured build.

Regression fixtures retain the native standing/pacing interface and real prepared-exit helper dependencies. Confirmed passage releases are modeled faithfully. Under that model both the baseline and corrected runtimes take the same legal411-packet historical escape, so the corpus uses the harness's normal bounded512-packet allowance while retaining its60second scene deadline and repeated-pose limit. Complete failed-suite output is now preserved under the ignored movement-suite-reports directory; startup notices can no longer hide the actual assertion.

Final post-hour validation completed97 movement-suite invocations with zero new regressions; the19 named pre-existing assertions remain unchanged. The separate future-clone fidelity suite passed115/115, and collision validation passed427/427. Failed earlier runs, the restored ordinary planner default and the reproduction corrections remain recorded rather than being counted as passes.
