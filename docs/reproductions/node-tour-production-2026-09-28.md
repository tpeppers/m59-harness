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
