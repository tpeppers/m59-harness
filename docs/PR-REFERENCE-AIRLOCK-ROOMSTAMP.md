# Reference: airlock + room-stamp guard

These two fixes are deeply integrated into our `ControllerMover` and
`Client` classes. Rather than a drop-in patch, this is a reference
implementation with clear integration notes.

## 1. The airlock (room-transition safety)

**The bug:** When a character crosses a go-exit, the server sends
`BP_PLAYER` (new room ID, old position) before `BP_ROOM_CONTENTS`
(new position). The mover was adopting the stale position (old room
coords) in the new room before `BP_ROOM_CONTENTS` arrived, causing
characters to end up in "bizarre spaces" (inside walls, outside
grids, or at staging squares of other rooms).

**The fix:** On room change, ALL movement stops. The airlock holds
until `BP_ROOM_CONTENTS` confirms the new position. This makes the
order-of-operations bug impossible by construction.

### Integration notes

1. **Track `_lastContentsRoom` in the client.** When `BP_ROOM_CONTENTS`
   includes our character, set `c._lastContentsRoom = roomNum`. This
   is the confirmation signal — the server has told us the character
   is in the new room.

2. **Add an airlock state to the mover.** When the room changes
   (`c.room.id !== this._room`), set `this._airlock = { from, to,
   since: Date.now() }` and return `{ state: 'airlock' }` (refuse all
   movement).

3. **Release the airlock on confirmation.** On each tick, if
   `this._airlock` is set and `c._lastContentsRoom === this._room`,
   release the airlock (`this._airlock = null`), force-adopt the
   server's position (`syncFrom(c.self)`), and resume movement.

4. **Timeout.** If the airlock is held for >5s, release with a warning
   (the confirmation never came; the character is stuck but should
   not be frozen forever).

### Reference code (from our `ControllerMover`)

```js
// In the mover's tick/step method:
if (c.room.id !== this._room) {
  // ENTER THE AIRLOCK.
  this._airlock = { from: this._room, to: c.room.id, since: Date.now() };
  return { state: 'airlock' };
}
if (this._airlock) {
  const confirmed = (c._lastContentsRoom != null
      && Number(c._lastContentsRoom) === Number(this._room));
  if (confirmed) {
    // RELEASE: force-adopt the server's position, resume.
    this._airlock = null;
    this.syncFrom(c.self);
  } else if (Date.now() - this._airlock.since > 5000) {
    // TIMEOUT: release with a warning.
    console.error(`airlock timeout after 5s — releasing with unconfirmed position`);
    this._airlock = null;
    return { state: 'airlock' };
  } else {
    return { state: 'airlock' };
  }
}
```

## 2. The room-stamp guard (stale path/position refusal)

**The bug:** After a room change, stale paths and positions from the
old room were being used in the new room, causing movement to wrong
coordinates.

**The fix:** Every path and position is stamped with the room it was
created in (`_roomStamp`). If the room changes, stale paths/positions
are dropped/refused at send time.

### Integration notes

1. **Track `_roomStamp` in the client.** Increment on `BP_PLAYER`
   (room change). This is a monotonically increasing counter.

2. **Stamp paths and positions.** When creating a path or position,
   record the current `_roomStamp`. When sending a move, check the
   stamp: if it doesn't match the current `_roomStamp`, refuse the
   move (it's stale).

### Reference code (from our `Client` and `Mover`)

```js
// In the client:
onBP_PLAYER() {
  this._roomStamp = (this._roomStamp ?? 0) + 1;
  // ... existing room-change handling ...
}

// In the mover (when creating a path):
this._pathStamp = c._roomStamp;

// In the mover (when sending a move):
if (this._pathStamp !== c._roomStamp) {
  // STALE: the room changed since this path was created. Refuse.
  return { refused: true, reason: 'stale_path' };
}
```

## Why both?

The airlock is the primary defence (it stops ALL movement on room
change). The room-stamp is belt-and-braces (it catches any stale
path/position that slips through). Together, they make the
order-of-operations bug impossible by construction.
