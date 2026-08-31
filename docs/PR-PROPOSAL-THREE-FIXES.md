# Proposal: three fixes for the tick keeper

We're working in parallel on the tick keeper. We've built three fixes
that we think would benefit your tree. None of them are architecture
changes — they're bug fixes.

## 1. The airlock (room-transition safety)

**The bug:** When a character crosses a go-exit, the server sends
`BP_PLAYER` (new room ID, old position) before `BP_ROOM_CONTENTS`
(new position). The mover was adopting the stale position (old room
coords) in the new room before `BP_ROOM_CONTENTS` arrived, causing
characters to end up in "bizarre spaces" (inside walls, outside grids,
or at staging squares of other rooms).

**The fix:** On room change, ALL movement stops. The airlock holds
until `BP_ROOM_CONTENTS` confirms the new position. This makes the
order-of-operations bug impossible by construction.

**Where:** `m59-controller-mover.mjs` (a new file in our tree). The
airlock is a ~30-line block that checks `_lastContentsRoom` and
refuses movement until it matches the current room.

## 2. The room-stamp guard (stale path/position refusal)

**The bug:** After a room change, stale paths and positions from the
old room were being used in the new room, causing movement to wrong
coordinates.

**The fix:** Every path and position is stamped with the room it was
created in (`_roomStamp`). If the room changes, stale paths/positions
are dropped/refused at send time.

**Where:** `m59-client.mjs` (track `_roomStamp`, increment on
`BP_PLAYER`), `m59-controller.mjs` (stamp positions), `m59-mover.mjs`
(stamp paths).

## 3. The policy unification (eliminate "lost on restart")

**The bug:** `autopilot set` wrote the roster but not the loadout, so
a change was lost on restart (the loadout overlay re-won). Four
characters re-assigned to room 534, confirmed in roster + status,
still hunting 575 an hour later.

**The fix:** `autopilot set` now also writes the loadout (for
`POLICY_KEYS` — the closed set of per-character standing
preferences). The loadout is the source of truth for those keys; a
restart re-applies the latest values.

**Where:** `m59-broker.mjs` (the `writeLoadoutPolicy` helper + the
call in the `autopilot set` handler).

## Why these matter

All three are bug fixes that make the tick keeper more robust. None
of them change the architecture — they fix order-of-operations bugs
(airlock), stale-state bugs (room-stamp), and persistence bugs
(policy unification).

We're happy to port them into your tree if you want. The airlock is
the most self-contained (a new file + a ~30-line block). The
room-stamp and policy unification require adapting to your existing
code.

## Reference implementations

- **Airlock + room-stamp:** see `docs/PR-REFERENCE-AIRLOCK-ROOMSTAMP.md`
  (deeply integrated into our `ControllerMover` and `Client` classes;
  reference implementation with integration notes).
- **Policy unification:** already ported into this branch (see the
  `writeLoadoutPolicy` helper + the call in the `autopilot set`
  handler in `m59-broker.mjs`).
