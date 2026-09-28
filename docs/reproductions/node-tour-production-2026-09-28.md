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

Next experiment: one bounded retry with the ownership repair and journal capture,
keeping survival active. Stop the queue if Victoria still causes a survival exit;
inspect its recorded threat/predicate before changing movement or dispatching
another character.
