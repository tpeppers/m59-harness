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
   from r15c55/r15c56 to r8c55/r8c56. Clear the landing at r7 before releasing
   the next character in the same lane.
6. Fine route to r1c62 and cross north into the eastern section of 578.
   Route to the eastern mouth near r27c50, then cross into 826.
7. Follow the winding cavern to the real east exit at r19c44 and cross into
   827. The locked eastern squares near rows 3–5 are a separate component.

Fine points use the existing 1024-unit client/BSP convention and are
converted with `m59-finepos.mjs`. Each new fall remains a declared running
fall, checked by the existing timed gravity, wall, body and step predicates.

## Lift timing and shared batches

`kod/object/active/holder/room/monsroom/g9.kod:17-53,181-230,306-322,422-475`
defines the platform, working levers, height range and speed. Stock
`clientd3d/roomanim.c:487` animates KOD height units per second:

`(800 - 250) / 15 = 36.666… seconds`.

The route waits **37,667 ms**, then checks the current server-observed sector
heights. Observing a destination packet alone does not skip the wait.
`m59-moving-platform.mjs` applies observed floor changes to the same collision
geometry and rebuilds its mask; it does not change movement rules or server
geometry. Sector 10 is a ceiling, not a floor.

The lift stays solved for 120 seconds, then descends. The reset also locks
the levers for another 120 seconds (`g9.kod:328-376,409-417`). A completed
batch therefore reserves the mechanism until 241 seconds after its recorded
raise. A partially operated failed puzzle uses the more conservative
five-minute touched timeout, rearm delay and descent allowance.

An endpoint-keyed journal under the shared evidence directory,
`brax-groups/`, lets separate callers join one 60-second boarding window.
Admission closes at 25. Each character controls only its own movements and
assigned levers; the leader operates the center. An atomic short-lived
filesystem mutex protects journal changes across processes. No socket work
runs under that mutex. Ambiguous ownership or unreadable state fails closed.

Room texture replay and pillar lights can impose the existing temporary
collision guard. The rail follower and platform walker wait at the same aim,
bounded by 45 seconds, and retain cancellation, room-change, wall and body
refusals. They never advance through refused aims.

## Evidence and limits

Local trials use only new `braxtest01`/Alfa, `braxtest02`/Bravo and
`braxtest03`/Charlie on fleet `brax-test`, broker 8981, sharing the existing
native movement server at 127.0.0.1:15959. Each has a keeper and verified
creation attributes. Administrative placement and health grants occur only
in the trial setup, before the measured route. The public script imports no
administrative tools.

Detailed movement and objective receipts are under `substrate/brax-attempts/`.
The early failures remain there, including the delayed final-lever message
and the room-entry animation refusals. Success totals and exact final trial
IDs are recorded after live verification.

The layout and assignment tests cover 25 members; a three-character live
trial is the group-scale check. A 25-character live convoy and arbitrary
hostile crowd tolerance require their own evidence. A blocked or interrupted
character must produce a failure receipt rather than an arrival claim.
