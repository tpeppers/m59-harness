# First production circuit attempt

Build `4c1b150`, deploy `deploy-2026-09-28-47`, selected keeper verified at the
same commit. One character, Raphael, started room 2 r3c42 with 25/25 health.
No node interaction occurred. All other campaign entries remained pending.

The first Victoria approach entered room 39 r8c28. At waypoint 8 the body was
instead in room 38 r2c19, health 22/25. Keeper counters recorded one fled room;
the exact survival predicate was not retained in its short recent journal.
This is a survival/scene outcome, not evidence that the checked rail cannot walk.

The automatic return then failed in room 38 r16c16: the FleetScript heartbeat
explicitly cancelled the tour's own travel on a lease retake at 20:41:39 UTC.
The tour issued movement inside a verify callback and child fineclimb process,
without setting the existing `__m59OwnWalks` marker. The repair keeps this marker
alive for normal and recovery tours. A regression covers nested ownership and
cleanup on rejection. Refused fine walks now refresh their actual room before
interpreting floor coordinates. Tours also save the keeper journal every five
seconds, so the next survival exit has a named reason.

A normal FleetScript `walk(2)` returned Raphael to room 2 r19c8 at 20:42:41 UTC,
25/25 health, mode survive, enchant-weapon service available and no commitment.
There was no death, administrative placement, or grant claim.

Runtime evidence in the production checkout:

- `substrate/node-campaign/hk3-1790627993574/five-node-1790628040214.json`
- `substrate/node-campaign/hk3-1790627993574/five-node-1790628091485.json`
- `substrate/node-campaign/first-flight-recorder.jsonl`
- `substrate/node-campaign/first-return.json`

## Second attempt and current blocker

Build `a8884d5`, deploy `deploy-2026-09-28-49`, keeper PID 58640 verified on
that build. At 20:49:57 UTC Raphael entered room 39 r9c27 at 19/25 health.
The keeper journal named the predicate: health 76% below `restBelow` 85%, ten
monsters, no reachable proven wall. `m59-autopilot.mjs`'s
`mustLeaveForHealth && combatZone && !sheltered && !testing && !this.hold`
branch correctly took the exit to Castle Victoria. Fineclimb refused to start
in the wrong room. The ownership fix retained the tour's walk during lease
retake, as the log explicitly confirms.

The single-hop recovery raced a survival trip between rooms 38 and 39 and used
its hop before reaching room 2. A recovery-aware FleetScript waited for 25/25
health, then walked 38 → 2 and reached the desk r19c8 at 20:51:41 UTC. This
measured fallback is now part of the campaign for room 38 or room 2 only;
special node-room exits remain checked rails. Failed trials remain failed.

Second evidence:

- `substrate/node-campaign/hk3-1790628503427/five-node-1790628565710.json`
- `substrate/node-campaign/hk3-1790628503427/five-node-1790628565710-keeper.jsonl`
- `substrate/node-campaign/hk3-1790628503427/five-node-1790628601577.json`
- `substrate/node-campaign/second-return.json`

Production status: **0/2 Victoria arrivals, no node interactions; other four
nodes not attempted on production.** All 23 other characters remain queued.
No deaths or max-health loss in either attempt. The quiet shadow full circuit
remains separate evidence, not production success.

Next experiment must change the measured condition: clear the castle entrance
with a suitable escort, or establish a sheltered approach before sending the
25-health enchanter again. Capture the entry scene and verify health stays
above the recovery threshold before the fine rail begins. Do not repeat the
same solo entry or disable survival merely to force the itinerary.

## Cache-aware campaign: busy owner transition

On build `24b651f`, two starts stopped in room 2 before any node interaction.
The first followed a selected-keeper restart and overlapped a supply handoff;
the second did not restart. Both recorded `declared busy` under the FleetScript
owner interrupting `walk to Castle Victoria`. The initial broker announcement
had belonged to the prior director because the keeper claim followed it.
The first ten-second busy renewal changed owners, so the keeper correctly
treated it as a new operation and cancelled the already-started script walk.

`holdKeeper` now announces busy to the actual keeper after claiming and clearing
the prior journey, before returning control to the script. Replacement keepers
use the same path. A regression drives the real `Autopilot.declareBusy` through
the compiler and verifies that renewal does not interrupt the new owner's walk.
Survival remains enabled. Raphael returned to room 2 r19c8, 25/25 health,
enchant-weapon service available; the other 23 entries remained pending.

Evidence: `substrate/node-campaign/hk3-1790632244168/five-node-1790632296182.json`
and `substrate/node-campaign/hk3-1790632335545/five-node-1790632345995.json`, with
their adjacent `-keeper.jsonl` journals and `desk-recovery.json`.

## Director handoff and combat-displaced boarding

Build `7bf399e` fixes the initial busy-owner transition (368 FleetScript checks,
15 movement suites, zero new regressions). An additional attempt exposed DUM's
independent claim-restoration loop. Production has two running directors on
loopback 8916 and 8917; both support the authenticated 45-second per-character
`/tactical` reservation. Reserving Raphael on both, heartbeating during the
campaign, and releasing after cleanup prevented the competing claims without
stopping either director or changing saved policies. The local wrapper is
`substrate/node-campaign/run-reserved.mjs`; its receipts are `handoffs.jsonl`.

The reserved attempt reached room 38 at r15c17 with 25/25 health, then room 39
at r9c31 with 19/25 health. The fine follower observed r10c31 and refused
`not on the rail` (distance printed as 2.0 squares, exceeding the 2-square
boarding threshold). Recovery observed r10c33, floor 2048, and refused its
return rail at 2.5 squares. Neither node activation nor mana grant occurred.
This is a combat-displaced boarding defect, not evidence that the node rail
itself cannot walk. Do not increase the boarding radius without checking the
connector and its shelf.

Evidence: `substrate/node-campaign/hk3-1790633395150/five-node-1790633405642.json`,
its `02-rail-victoria-follow.txt`, and recovery
`five-node-1790633435254-00-rail-victoria-follow.txt`. After the failure, a separate
reserved, health-gated FleetScript returned Raphael to room 2 r19c8 with 25/25
health and 25/25 mana. Receipt: `substrate/node-campaign/reserved-desk-return-1790633525839.json`.
Enchantment service was read back as available; both reservations were released.
The queue remains stopped on Raphael, with the other 23 entries pending.

Next experiment: reproduce the captured room-39 body and monster scene on the
shadow, cut a floor-checked connector from the actual displaced fine point to
the inbound rail (and a separate exit connector), and require a stable survival
state before boarding. Exercise the displaced return as well as the approach;
do not advance the production queue on a failed route or merely lower survival
thresholds to make the rail start.
