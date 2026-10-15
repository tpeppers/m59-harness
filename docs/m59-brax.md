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
   from r15c55/r15c56 to r8c55/r8c56. Form two half-square-spaced departure queues, then clear the landing at r7 before releasing
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
