# Travel recovery after the September 13 deaths

The overnight production window contained 74 deaths: 50 while travelling,
18 recovering, and 6 stalled. Most occurred in the Badlands and Flatlands.
These fixes address reproduced control-flow failures in those journeys:

- A room-wide count of six monsters vetoed route shelter requests and removed
  walls from recovery searches. Collision-tested refuges remain eligible now;
  the crowd restriction on leaving cover to pull another monster remains.
- An internal travel lease timer recreated a travelling hold after the watchdog
  cancelled it, erasing the suspended destination. It now renews only its own
  unrevoked hold and retains the original movement generation.
- A cancelled stockpile leg could immediately start an apothecary leg in the
  same pass. The shopping objective now keeps its service cursor through a
  survival pause, retries the interrupted purchase after recovery, and finishes
  the remaining shopping list. It is never discarded because of that pause.
  Recovery retains the forward shelter plan. Each journey has its own watchdog
  rescue allowance.
- Panic reconnects could leave movement active or continue into another ladder
  stage. The mover is cancelled before reconnecting, a freeze ends the pass,
  and monster attacks preserve the destination for recovery. The independent
  watchdog and the pass both end a freeze on damage, movement, or death.
- Successful recorded-track crossings skipped hop recovery. They now run the
  same hook as other crossings. A failed walk to a refuge cannot start a rest
  at the character's actual, exposed position.
- Live verification caught a failed-rest loop: Bunsen released a square after
  taking damage, then immediately chose that same square again. Failed rest
  squares now enter a five-minute exclusion local to that keeper, shared by
  recovery and route shelter searches. Historical ledger failures still do not
  determine the geometry verdict. A failed selection is reported as a failure.

`m59-survival-handoff-test.mjs` holds a real travel call open while the real
watchdog interrupts it. It also exercises real freeze/pass and shopping
handoffs. `m59-travel-test.mjs` covers track hooks, cancellation, and false
refuge arrivals. All fixtures are offline; no production characters are joined.

Damage during a freeze is reported with the preceding health/position, current
health/position, and any held square. It invalidates the claimed protection;
the event alone does not establish whether geometry, movement, or another
damage source broke it.
