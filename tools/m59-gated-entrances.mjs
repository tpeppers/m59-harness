// AN ENTRANCE THAT IS ONLY THERE HALF THE TIME.
//
// Some code exits (substrate/m59-codeexits.json) fire on a square that a sector lift opens and
// shuts on the server's clock. The trigger does not care — `SomethingMoved` hands you across from
// that square whatever the lift is doing — but the square is only WALKABLE while the lift is open,
// and the server is two-dimensional, so the only thing enforcing that is us.
//
// The Temple of Qor (802) is the case, and the only one declared so far:
//
//   tempqor.kod ExitsTimer, every EXIT_DELAY (600000 ms), picks the OTHER of RID_I8 / RID_H9 and
//   sends it OpenQorTemple, and CloseQorTemple to the one it left. With two candidates that is a
//   strict alternation: one entrance is open at a time, for ten minutes.
//
//   598 (i8.kod)   QOR_DOOR = 1, ANIMATE_CEILING_LIFT, open 348 / shut 284, speed 8.
//                  SomethingMoved fires at r38c26, the south end of a one-square corridor
//                  (c26, r35-r38) whose ONLY mouth is r34c26 in the bowl to its north. Sector 1
//                  is the corridor's first square, r35c26: shut, its ceiling comes down to its
//                  floor and the corridor is sealed.
//   589 (h9.kod)   QOR_DOOR = 1, ANIMATE_FLOOR_LIFT, open 290 / shut 350.
//                  SomethingMoved fires at r26c12, the end of a corridor (r24-r26 c12, ceiling
//                  350) whose only way in is from a sunken pit (sector 99, floor 300) across the
//                  lift's rim. Shut, the rim rises 50 over the pit floor (more than the 24-unit
//                  step) and seals it. But the pit itself is where ExitFromQor puts a body
//                  leaving the temple (r22c13); its stair climbs to a ledge 116 above the ground
//                  around it, and nothing in the room steps or falls back into it. So from
//                  anywhere a journey can arrive in 589, its Qor entrance is not walkable at any
//                  lift height. `m59-qor-temple-test.mjs` pins that with the mover's own flood.
//
// What this file owns is the DECLARATION and the reading of a live height against it. Deciding
// whether the trigger can be walked to is the router's (`World.transitOk`, which now floods from
// the door a journey came in by), and the wait is the session's (`holdForGatedEntrance`).
//
// COORDINATE CONTRACT: squares are named 1-based `{row,col}` KOD squares, like walk_to's.

export const GATED_ENTRANCES = Object.freeze([
  Object.freeze({
    room: 598, to: 802, name: 'Temple of Qor, Cragged Mountains entrance',
    sector: 1, lift: 'ceiling', open: 348, closed: 284, speed: 8,
    trigger: Object.freeze({ row: 38, col: 26 }),
    // THE CORRIDOR'S MOUTH, AND WHERE TO WAIT FOR IT. Walking straight at the trigger plans
    // through a diagonal from r39c25 that lands only from that square's exact stand point
    // (68% of plans from the north take it); the walker never stands there and slides off
    // wall 69. From the mouth the trigger is four straight steps down the corridor.
    via: Object.freeze({ row: 34, col: 26 }),
    wait_at: Object.freeze({ row: 34, col: 26 }),
    cycle_ms: 600000, group: 'qor-temple',
    cite: 'kod/object/active/holder/room/monsroom/i8.kod OpenQorTemple, CloseQorTemple, SomethingMoved; ' +
          'kod/object/active/holder/room/tempqor.kod ExitsTimer, EXIT_DELAY',
  }),
  Object.freeze({
    room: 589, to: 802, name: 'Temple of Qor, Sentinel entrance',
    sector: 1, lift: 'floor', open: 290, closed: 350, speed: 8,
    trigger: Object.freeze({ row: 26, col: 12 }),
    cycle_ms: 600000, group: 'qor-temple',
    cite: 'kod/object/active/holder/room/monsroom/objroom/h9.kod OpenQorTemple, CloseQorTemple, ' +
          'SomethingMoved, ExitFromQor; kod/object/active/holder/room/tempqor.kod ExitsTimer',
  }),
]);

/** The declared gate on `room`'s code exit to `to`, or null. */
export function gatedEntrance(room, to) {
  const r = Number(room), t = Number(to);
  return GATED_ENTRANCES.find(g => g.room === r && g.to === t) ?? null;
}

/** Every declared entrance into `to`, in declaration order. */
export function entrancesInto(to) {
  return GATED_ENTRANCES.filter(g => g.to === Number(to));
}

// `BP_SECTOR_MOVE` animation types, as m59-client records them: 4 a floor lift, 5 a ceiling.
const LIFT_TYPE = { floor: 4, ceiling: 5 };

/**
 * What the lift is doing, from what the server has told THIS client in THIS room.
 *
 * `sectorHeights` is `client.room.sectorHeights`: sector id -> `{ type, height, speed }`. It is
 * reset on every room entry and the room replay re-sends every sector that has moved, so it is
 * the server's word for the room the body is standing in, and nothing else.
 *
 *   open      the last height the server sent is the open one
 *   closed    it is the shut one
 *   moving    some other height (a lift reversed part way, or a table that is out of date)
 *   unknown   the server has said nothing — the lift is where the .roo ships it. 598 ships OPEN
 *             (348), so this is the state a freshly started server is in until the first timer.
 */
export function gateState(entrance, sectorHeights) {
  if (!entrance) return { state: 'unknown', height: null, observed: false };
  const seen = sectorHeights?.get?.(entrance.sector) ?? null;
  const want = LIFT_TYPE[entrance.lift];
  // A ceiling update is not a floor height and the reverse; ignore the other kind rather than
  // read a ceiling of 290 as an open floor.
  if (!seen || !Number.isFinite(seen.height) || (seen.type != null && want != null && seen.type !== want))
    return { state: 'unknown', height: null, observed: false };
  const state = seen.height === entrance.open ? 'open'
    : seen.height === entrance.closed ? 'closed' : 'moving';
  return { state, height: seen.height, observed: true,
           ...(Number.isFinite(seen.speed) ? { speed: seen.speed } : {}),
           ...(Number.isFinite(seen.at) ? { at: seen.at } : {}) };
}

/** Passable as far as anybody knows: open, or never reported moved (the shipped state). */
export const gatePassable = st => st?.state === 'open' || st?.state === 'unknown';

/**
 * How long the lift takes to travel between its two heights, from the server's own speed
 * (stock client MoveSector: |dest - source| / speed seconds), plus a margin.
 */
export function liftTravelMs(entrance, speed = entrance?.speed) {
  const s = Number(speed);
  if (!entrance || !Number.isFinite(s) || s <= 0) return 0;
  return Math.ceil(Math.abs(entrance.open - entrance.closed) * 1000 / s) + 250;
}

/**
 * WAIT FOR THE SERVER TO OPEN IT, BOUNDED BY ONE CYCLE.
 *
 * Never a duration guessed from the clock: the timer started whenever the server started, and
 * nothing on the wire says when it fires. So this polls the height the server last sent for
 * this room, and returns as soon as it reads open AND the lift has had time to finish moving.
 * The bound is one full cycle plus a minute — with a strict alternation the lift must open
 * within one cycle of being seen shut, so a wait longer than that is not a slow lift, it is a
 * wrong model, and saying so beats standing in the mountains for an hour.
 *
 * Returns `{ opened, waited_ms, reason }`. Never throws.
 */
export async function waitForGateOpen(c, entrance, {
  cancelled = () => false, timeoutMs = null, pollMs = 1000,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const began = now();
  const limit = Number.isFinite(timeoutMs) ? timeoutMs : (entrance?.cycle_ms ?? 600000) + 60000;
  const room = c?.room?.id;
  const left = () => room != null && c?.room?.id !== room;
  let openedAt = null, speed = entrance?.speed;
  while (true) {
    if (cancelled()) return { opened: false, cancelled: true, waited_ms: now() - began, reason: 'movement cancelled' };
    if (left()) return { opened: false, waited_ms: now() - began, reason: 'left the room while waiting for the gate' };
    const st = gateState(entrance, c?.room?.sectorHeights);
    if (st.state === 'open') {
      if (openedAt == null) { openedAt = st.at ?? now(); speed = st.speed ?? speed; }
      if (now() >= openedAt + liftTravelMs(entrance, speed))
        return { opened: true, waited_ms: now() - began, height: st.height };
    } else openedAt = null;
    if (now() - began >= limit)
      return { opened: false, waited_ms: now() - began, state: st.state, height: st.height,
               reason: `sector ${entrance.sector} in room ${entrance.room} did not open within ` +
                       `${Math.round(limit / 1000)}s (last ${st.state}${st.height != null ? ' at ' + st.height : ''})` };
    await sleep(pollMs);
  }
}
