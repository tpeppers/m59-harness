# Emergency chalice evacuation, version 3

Start `node tools/m59-fleet-repl.mjs --fleet prod`, then run:

```text
panic-chalice agents=t3,t6,t7,t11,t12,t14,t15,t19,t21 destination=2001
```

Select explicit automated characters and coordinate with other controllers first.
The catalog filters human-piloted characters before claiming keepers. The ordinary
FleetScript runner owns work, movement and economy; protected survival remains
with the keepers. This upgrade changes only the runner, with no broker or keeper
restart and no live evacuation performed as part of the upgrade.

## Theft and charge protection

Handoffs and returns use direct
`supply` trades between exact fleet characters, with `who_travels=neither` and
the short survival-preemptible stationary hold. **Only necessary refills use
floor drops**, and only in a known `REFILL_ROOMS` room.

The native `UserGet` range check is **abs(delta row) + abs(delta col) <= 7**
(`user.kod:3634`, verified in both local server trees). This is a diamond: seven
squares straight or three diagonally are in range; four diagonally are outside.
The refill guard adds four squares for movement/latency and refuses a drop if an
enemy or untrusted player is within **11 by that measure**, even behind a wall.
Unknown positions, stale IDs, missing object lists and unknown rooms fail closed.
Only exact selected roster character names are trusted; enemy relation overrides
that trust. Other friendly-looking players are conservatively treated as potential
cup takers. The current body itself is excluded by its fresh identity.

Each refill gets a fresh room projection immediately before the drop. After a
confirmed drop it immediately submits pickup of the same cup, with no intervening
reads, sleeps or charge checks. Recovery must prove the exact cup is back and its
condition is full before the charge ledger is reset. Refills in one room are
serialized; unresolved recovery prevents further drops there. A saved floor
receipt precedes the drop packet. Unknown commands or failed recovery trigger
manual help, no blind retry, and block automatic reuse.

Drop/get is two player actions, not an atomic server operation. The fresh check
and movement buffer reduce the theft window; an unseen/newly arriving player or
network delay can still defeat it. The policy does not claim zero theft risk.

**Every sip preserves at least one charge.** Before every drink, the runner reads
the cup's description and intersects its possible native capacity/charge values
with its own spend ledger. It refuses unknown descriptions, contradictory
conditions and any condition that could mean a single charge. Each native cup
has capacity 3–5. “Full” proves at least three charges; a vague “few sips” can
include one remaining charge and must not be treated as permission to drink.
These rules use `chargePossibilities` from the existing Rescue module.

Desk planning reserves one final charge and the owner's own escape before every
loan. Without a refill, a full cup of unknown capacity supports **one borrower
plus its owner**, leaving at least one charge. In refill rooms desks may accept
additional riders, but must safely refill and prove at least three charges before
each additional loan. An owner with a possible single charge also tries a guarded
refill before its own sip. If the guard refuses, the next borrower is skipped;
the owner can still escape on its reserved charge when safe. No rule permits a
last-charge sip when refreshing is unavailable. Existing full cups are not
unnecessarily dropped. Seven full cups handle the original seven owners and two
borrowers without any floor exposure.

Before each transfer, the sender must have exactly its expected cup and the
recipient must have none. The exchange and fresh inventories prove the handoff.
This also avoids native cup merging/deletion when accepting a second chalice.

## Speed and deadlines

Independent holders drink immediately. Borrowers are distributed across multiple
desks; each desk runs concurrently, trades its cup out, receives it back, and
drinks last. Landing observers overlap the rest of the operation. Borrower
observation starts after the return attempt so polling cannot interfere with
that borrower's trade window. The rescue delay never requires retaining a cup.

Only serving desks and their borrowers need to gather. They first converge at
the common desk location in their current room. At 30 seconds from maneuver
start, failed gathering is cancelled and the group seeks proved local safe spots
and casts Blink. Relocation and same-room handoff range must be confirmed.
There is no road travel or drop fallback when Blink, visibility or trading fails.
Local walks mask room boundaries and known exit triggers.

`gatherMs` defaults to 30000 and cannot exceed it. `budgetMs` defaults to 120000
and is limited to 60000–120000. With the default, new rescues stop being admitted
at 85 seconds, leaving 35 seconds for native rescue and confirmation. No new
borrower exchange begins without additional exchange allowance. Blink attempts
and refuge approaches have phase deadlines. Missing landings are reported after
45 seconds or the overall deadline, whichever comes first.

These are planning and observation budgets, **not a guaranteed escape time**.
PvP teleport lockouts, damage preempting stationary trades, insufficient charges,
unreachable cover, absent Blink resources and delayed/offline keepers can prevent
completion. A client RPC timeout cannot cancel a mutation already running in the
broker. Timed-out cup commands are marked uncertain, never retried, and block
further scripted mutations of that cup. Manual help is required for affected
characters. Already independent characters continue escaping.

## Receipts and reuse

Receipts live in `substrate/scratch/panic-chalice/` and include the version,
charge ledger, proved cup holder, per-agent pending/arrival state, elapsed time,
sip spread, failures and `manual_help`. Pending state is persisted **before**
the use packet. A lost reply never authorizes another drink. On a lost sip reply,
the borrower keeps the cup while its possible rescue is watched. No return trade
is started while that use command might still be in flight.

The catalog checks earlier receipts before claiming bodies. Unresolved floor
recovery always blocks reuse. Unresolved pending
sips block automatic reuse unless the character is positively at the expected
landing. An ambiguous trade/use command requires manual review regardless of
location. A malformed receipt fails closed. Do not delete receipts to bypass
these checks: resolve the character, cup and outstanding command first.

Arrivals remain idle with `assigned_room=destination`,
`confine_rooms=[destination]` and `roam=false`. A standing posture may reassert
survive mode. Prior outbound orders are not restored. Coordinate with the main
fleet controller to keep this confinement in place.

The destination is an expected **native Rescue landing**, not a teleport selector.
On the island it is Aerie Guest House, room 2001.

## Verification and history

`node tools/m59-panic-chalice-test.mjs` uses a concurrent simulated clock and the
actual orchestrator. It covers hostile presence, multiple parallel desks,
preserving every possible final charge, ambiguous conditions, interrupted trades,
lost sip replies, PvP refusal, failed Blink, missing landings, deadline admission,
early teleport during return, and repeated catalog compilation. Guarded-refill
tests cover pickup range and buffer boundaries, new enemy arrivals, unknown
positions, last-charge recovery, non-refill rooms, failed pickup/drop, failed
charge refresh, and serialized floor exposure with unresolved-recovery blocking.

The nine-character simulation (seven full cups, two borrowers, 4-second trades,
0.1-second other RPCs and a 25-second native rescue delay) completes in **35.9
seconds**. With the 30-second gather fallback, 8-second trades and 0.2-second
other RPCs, it completes in **76.4 seconds**. These are simulated timings, not live
performance promises.

Version 1's production run on October 27, 2026 (Pacific) evacuated all nine jungle
characters with unchanged full health and seven retained cups. It used floor
handoffs and one sequential desk, taking 76.2 seconds inside the maneuver with
37.7 seconds between first and last accepted sips. The upgraded runner has not been run on
production; the already rescued characters were not disturbed to benchmark it.

Native source consulted: `chalice.kod` (`ReqNewOwner`, `NewOwner`,
`ReqNewApply`, `NewApplied`); existing charge interpretation and tests in
`m59-rescue.mjs`; verified peer exchange in `m59-supply.mjs`. The chalice is
deleted on its last sip and can merge when a recipient already holds another.
