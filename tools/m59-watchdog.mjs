#!/usr/bin/env node
// m59-watchdog.mjs -- THE OUT-OF-BAND LIVENESS GUARD.
//
// Lifted verbatim out of m59-autopilot.mjs. BEHAVIOUR IS BYTE-FOR-BYTE WHAT IT WAS --
// this is a move, not a fix, the same way skills.isArmed was a move -- because the one
// thing worse than a guard in the wrong file is a guard whose behaviour quietly changed
// while it was being tidied.
//
// WHY IT EXISTS AT ALL. Everything else in both keepers is IN-BAND: it assumes pass()
// returns promptly and that the next pass will re-read the world. The watchdog is the
// only control that holds when that assumption fails, and it fails often enough to
// matter. Measured over 11,854 GOAP passes on this fleet: median 80ms, p90 448ms --
// and p99 16.6s, worst 207s. 376 passes (3.2%) ran past the interrupt threshold, and
// the long ones are FIGHTS ("fight did not end in a kill", worst 138.8s). The fight
// path checks health once on entry and never again, trusting "the next pass" to
// re-decide -- and the next pass can be two minutes away.
//
// So it is idle for 97% of passes and is the only thing alive during the 3% that kill
// somebody. That is the shape of a control that looks like dead weight right up until
// the incident.
//
// IT DECIDES NOTHING. Its only action is cancelMovement(), once per blocked pass, and
// only when health has crossed the withdraw line. The ordinary pass -- which already
// knows how to flee and rest -- then decides with fresh numbers. A guard that started
// making policy would be a second opinion about survival, and this repository has paid
// for every quantity that grew a second home.
//
// ---------------------------------------------------------------------------
// THE HOST INTERFACE
// ---------------------------------------------------------------------------
//
// The watchdog reads a HOST rather than a keeper, so either driver can run it. The
// Autopilot satisfies this shape as-is; the GOAP keeper supplies an adapter.
//
//   host.s              the session (needs .client, .live, .cancelMovement())
//   host.watch          this module's own scratch state, created by start()
//   host.inert          something else is driving -- do not cancel under it
//   host.hold           holding a safe spot: standing still ON PURPOSE
//   host.doing          'travelling' | 'pulling' | 'converging' | 'zoning' | ...
//   host.passes         pass counter, so an interrupt fires once per pass
//   host.passStartedAt  when the current pass began -- how blindness is measured
//   host.lastFrameAt    when the record last got a frame
//   host.tally          counters
//   host.safety()       -> { fleeAt }
//   host.recordFrame(why)  host.note(msg, data)  host.progress(msg)
//
// A host that cannot answer one of these must supply a harmless default (false, null,
// or a no-op), NEVER a throw: an exception inside the tick would kill the timer and
// take the guard down silently, which is the one failure mode it cannot have.

// THE WATCHDOG'S THREE NUMBERS.
//
// The tick is fast because it is free: it reads `client.vitals()`, which the server
// pushes, and writes nothing to the wire. 500ms is well inside the ~1s pace at which
// damage can arrive, so nothing lands between two ticks unseen.
export const WATCHDOG_MS = Number(process.env.M59_WATCHDOG_MS || 500);
// How long a pass may be inside one await before the watchdog will interrupt it.
export const WATCHDOG_BLOCKED_MS = Number(process.env.M59_WATCHDOG_BLOCKED_MS || 3_000);
// The longest the record may go without a frame while nothing is changing. Matches
// WATCH_MS in m59-postmortems.mjs deliberately: the thing that reports blindness and
// the thing that prevents it must not disagree about what it is.
export const WATCHDOG_FRAME_MS = Number(process.env.M59_WATCHDOG_FRAME_MS || 8_000);
export const PULSE_MS = Number(process.env.M59_PULSE_MS || 1_000);
// SIX, NOT THREE, and the reason is a rate rather than a position. "How fast is it losing
// health" cannot be asked of three samples: damage lands about once a second, so a
// two-second window is one hit wide and reports either zero or enormous. Upstream measured
// a character losing 7 health over 22 seconds -- half a point a second, perfectly steady,
// and invisible to every two-second window in it. Six samples is five seconds of history.
export const PULSE_SAMPLES = 6;
// THE NEWEST FEW, for the questions that are about the body having MOVED rather than about
// how much time is left. Its own constant on purpose: `pennedIn` gets STRICTER as the ring
// grows, so widening the ring above would quietly switch off the rescue it feeds.
export const PULSE_MOVEMENT_SAMPLES = 3;
// How long a stationary, bleeding, INERT character waits for its driver before the keeper
// takes it back. Four pulses: long enough that a driver pausing at a door is not treated as
// an abandonment, short enough to matter at these health totals.
export const INERT_RESCUE_MS = Number(process.env.M59_INERT_RESCUE_MS || 4_000);
// HOW LONG A HEALTHY CHARACTER MAY BE PENNED IN WHILE SUPPOSEDLY GOING SOMEWHERE.
//
// Deliberately much longer than WATCHDOG_BLOCKED_MS. The 3s handbrake is an EMERGENCY —
// health has crossed the withdraw line and every second is damage. This one is not urgent,
// it is just wrong: nothing is hurting the character, so the only cost of waiting is time.
// A long fight, a slow pull and a mid-journey pause are all legitimately still for several
// seconds, and cancelling those would be the guard picking fights with the pass. Twenty
// seconds of covering no ground at all is not any of them.
export const WATCHDOG_PINNED_MS = Number(process.env.M59_WATCHDOG_PINNED_MS || 20_000);
// HOW FAR FROM WHERE IT STARTED STILL COUNTS AS GETTING NOWHERE, in squares.
//
// THIS IS A DISPLACEMENT TEST, NOT A STILLNESS TEST, and the difference is the whole
// reason the first version of this guard did not fire. `pennedIn` asks whether the newest
// three samples are within a square OF EACH OTHER, which a shuffle defeats: measured on
// prod 2026-08-27, Robin's wedge ranged over columns 71-74 while going nowhere, so every
// few samples were "moving" and the timer reset before it could ever mature. Anchoring
// instead — where were we when this started, and are we still near it — asks the question
// CLAUDE.md has been asking since the shuttle runs: not "is it still" but "has it
// covered any ground".
//
// EIGHT, AND THREE WAS TOO TIGHT — the radius has to cover the POCKET, not the step.
//
// Three was calibrated on one wedge (Robin's, four columns wide) and promptly missed the
// next one. Measured on prod 2026-08-27, Rowlf in Castle Victoria: `doing: zoning`, one
// pass for the whole window, wandering squares 24,3 · 25,3 · 28,3 · 29,3 · 29,4 — a pocket
// six columns across. Every time he crossed three squares the anchor moved and the timer
// went back to zero, so a character who covered no ground for minutes was never once
// flagged. A radius that a wedge can out-wander is not a radius.
//
// The headroom against a false positive is enormous either way, so spend it here. A
// character actually travelling runs at roughly five squares a second: twenty seconds of
// real movement is on the order of a hundred squares, and it leaves an eight-square box in
// under two. Anything still inside that box after twenty seconds is not on its way
// anywhere, and the cost of being wrong is one cancelled walk that the next pass re-decides.
export const WATCHDOG_PINNED_SQUARES = Number(process.env.M59_WATCHDOG_PINNED_SQUARES || 8);

// A WEDGE BROKEN BY A CANCEL IS A WEDGE RE-ISSUED. The second arm's whole action is
// `cancelMovement()`, "so the next pass can decide with real numbers" — and the numbers
// are not real, they are IDENTICAL: same square, same room, same destination, same policy.
// So the next pass emits the same walk, which wedges on the same server-side condition,
// and the arm breaks it again. Measured on `acba925`, one character, two incidents:
//
//   93 minutes in room 575 assigned to 586 — 217 passes, 589 wedge-breaks, 28 placement
//   failures all reading "movement cancelled by a newer command", zero rooms entered.
//
//   18.5 minutes on square 18,18 of room 586 — seven threats in the room, health 22 -> 3,
//   `squares_per_second: 0` across 46 post-mortem frames, every decision-trail entry a
//   variant of "moving to somewhere I can heal", and dead to a centipede mid-"travel".
//
// A cancel is only useful if the re-decision is CONSTRAINED TO DIFFER. So the arm now
// records where it broke the wedge and how many times running it has broken one at the
// same place, the pass reads that before setting out again, and the record has a cap:
//
//   repeats 1..CAP-1  the pass sidesteps in a rotating direction BEFORE re-planning, so
//                     the walk it issues starts from a different square than the one
//                     that wedged — the one input the planner cannot get from the map;
//   repeats >= CAP    the pass gives the objective up out loud, once, and holds in place
//                     for WEDGE_GIVEUP_HOLD_MS, which turns an unbounded loop into a
//                     bounded, observable failure with a single line an operator can act
//                     on. The record is dropped when the hold expires, so a wedge that
//                     was genuinely transient gets a fresh cycle rather than a permanent
//                     refusal.
//
// The place is compared with the same radius as the pinned anchor, for the same reason:
// a wedge that wanders a pocket is one wedge.
export const WEDGE_REPEAT_CAP = Number(process.env.M59_WEDGE_REPEAT_CAP || 5);
export const WEDGE_GIVEUP_HOLD_MS = Number(process.env.M59_WEDGE_GIVEUP_HOLD_MS || 120_000);

export function sameWedgePlace(a, b) {
  if (!a || !b || a.room == null || b.room == null || a.room !== b.room) return false;
  return Math.abs((a.col ?? 0) - (b.col ?? 0)) <= WATCHDOG_PINNED_SQUARES
      && Math.abs((a.row ?? 0) - (b.row ?? 0)) <= WATCHDOG_PINNED_SQUARES;
}

// Called by the second arm, once per break, with where the body was when the wedge was
// broken and what it was doing. Returns the record so the note can carry `repeats`.
export function noteWedgeBreak(w, { room, col, row, doing = null, to = null } = {}, now = Date.now()) {
  const here = { room, col, row };
  const prev = w.wedgeBreak;
  if (prev && sameWedgePlace(prev, here)) {
    prev.repeats += 1;
    prev.at = now;
    prev.doing = doing ?? prev.doing;
    if (to != null) prev.to = to;
    return prev;
  }
  w.wedgeBreak = { room: room ?? null, col: col ?? null, row: row ?? null,
                   doing: doing ?? null, to: to ?? null,
                   repeats: 1, first_at: now, at: now };
  return w.wedgeBreak;
}

// What the pass should do differently, asked from where it is about to decide. Pure: a
// record for somewhere else answers null and is the caller's to drop, because only the
// caller knows whether "somewhere else" means the wedge is over or the pulse is stale.
export function wedgeAdvice(w, here, now = Date.now()) {
  const b = w?.wedgeBreak;
  if (!b || !here || !sameWedgePlace(b, here)) return null;
  const base = { repeats: b.repeats, cap: WEDGE_REPEAT_CAP,
                 room: b.room, col: b.col, row: b.row, doing: b.doing, to: b.to,
                 wedged_for_ms: now - b.first_at, since_break_ms: now - b.at };
  if (b.repeats >= WEDGE_REPEAT_CAP) return { verdict: 'give_up', ...base };
  return { verdict: 'vary', ...base };
}

const pct = v => (v && v.max ? v.value / v.max : null);

// PENNED IN: the newest three samples, in one room, within a square of each other.
// Explicitly the newest three and NOT the whole ring -- the ring widened so a damage rate
// could be seen, and reading it here would demand a character stay in one square for six
// seconds instead of three. That is a handbrake loosened by an edit about something else.
export function pennedIn(w) {
  const ring = (w?.pulses ?? []).slice(-PULSE_MOVEMENT_SAMPLES);
  if (ring.length < PULSE_MOVEMENT_SAMPLES) return false;
  const last = ring[ring.length - 1];
  return ring.every(p => p.room === last.room
    && Math.abs((p.col ?? 0) - (last.col ?? 0)) <= 1
    && Math.abs((p.row ?? 0) - (last.row ?? 0)) <= 1);
}

// Penned in AND losing health. The pair is the whole test: standing still is ordinary,
// bleeding is ordinary, and standing still WHILE bleeding is the one that is not.
export function inertBleeding(w, hp) {
  if (!pennedIn(w)) return false;
  const prev = (w?.pulses ?? [])[(w?.pulses ?? []).length - 2];
  const now = hp?.value, before = prev?.health;
  return Number.isFinite(now) && Number.isFinite(before) && now < before;
}

// The scratch the tick keeps. Created here so a host cannot forget a field.
// THE STATES WHOSE WHOLE CONTENT IS "THE CHARACTER SHOULD BE GETTING CLOSER TO SOMEWHERE".
// One copy, because both the pulse and the handbrake below ask the same question and a
// second copy of this list is how one of them quietly stops matching the other.
export const GOING = ['travelling', 'pulling', 'converging', 'zoning'];

export function freshState() {
  return { ticks: 0, frames: 0, interrupts: 0, rescues: 0, rescuedPass: null,
           longest_block_ms: 0,
           lastHealth: null, blockedSince: null, interruptedPass: null,
           pulses: [], lastPulseAt: 0, wedged: null, wedges: 0,
           // When the body was first penned in while supposedly going somewhere, and how
           // many times that has had to be broken. See THE SECOND ARM in tick().
           pinnedSince: null, pinnedAnchor: null, pinnedInterrupts: 0,
           // Where the second arm last broke a wedge and how many times running it has
           // broken one there. See WEDGE_REPEAT_CAP.
           wedgeBreak: null };
}

// start/stop own the timer. `unref` so a watchdog never holds a process open.
export function start(host) {
  if (host.watchTimer) return host.watchTimer;
  host.watch = freshState();
  host.watchTimer = setInterval(() => {
    try { tick(host); } catch (e) { host.watch.lastError = e.message; }
  }, WATCHDOG_MS);
  host.watchTimer.unref?.();
  return host.watchTimer;
}

export function stop(host) {
  if (!host.watchTimer) return;
  clearInterval(host.watchTimer);
  host.watchTimer = null;
}


// ONE SAMPLE OF WHERE THE BODY IS, AND THE ONE QUESTION THAT NEEDS ASKING OF IT.
//
// Called from the watchdog tick, at most once per PULSE_MS. Everything here is memory:
// `client.self` is maintained from pushed packets and from our own dead reckoning, so
// this sends nothing and blocks on nothing, which is what makes it safe to run on every
// keeper in a broker holding twenty-one sessions.
//
// WHAT COUNTS AS STANDING STILL ON PURPOSE, because if this cannot tell those apart it
// is a false-alarm generator and will be turned off, which is how instruments die:
//
//   * resting and recovering — sitting down IS the behaviour; `restUntil` polls its own
//     vitals and aborts on damage, and it is supposed to take a while.
//   * holding a safe spot — the entire point is to stand exactly still on one square.
//     A wall that works looks identical to a wedge from the outside and is the opposite.
//   * inert — an errand or a bot owns the character. This keeper stood down deliberately
//     and does not get to call the thing it stood down for a stall.
//   * fighting, trading, waiting — none of them are going anywhere.
//
// What is left is `travelling`, `pulling`, `converging` and `zoning`: the states whose
// whole content is "the character should be getting closer to somewhere". Not moving
// during one of those, twice in a row, is the symptom the pocket trap presents with —
// and it is the symptom nothing here could state, because every other stall number is
// about the keeper and the keeper is working hard.
export function pulse(host, now, hp) {
  const w = host.watch, c = host.s?.client, me = c?.self;
  if (!w) return null;
  const doing = host.doing ?? null;
  // THE ROOM NUMBER, NEVER THE ROOM OBJECT'S ID. Ported back from the copy of this that
  // still lives in m59-autopilot.mjs, which had the fix while this module did not.
  //
  // `c.room.id` is a live object id. The server renumbers those on every system save, so it
  // is not a name for a room — it is a name for a HANDLE to a room, and it is a different
  // number after the next save. Two things went wrong with it: the ring is persisted into
  // every post-mortem, so a death record keyed on `1589` becomes unreadable the moment the
  // server saves; and it is COMPARED — `prev.room === last.room` is half the "has this
  // character moved" test, so a renumbering mid-session makes one room look like two, which
  // reads as movement and silently resets the wedge detector.
  //
  // Falls back to the live handle rather than to null: a null would make
  // `prev.room === last.room` true for every pair, so every character would read as never
  // having changed room. A stale-able id beats a field that makes the detector say yes always.
  const at = me ? { at: now, room: host.s?.world?.room?.num ?? c.room?.id ?? null,
                    col: me.col ?? null,
                    row: me.row ?? null, x: me.x ?? null, y: me.y ?? null,
                    health: hp?.value ?? null, doing } : null;
  if (at) {
    w.pulses.push(at);
    if (w.pulses.length > PULSE_SAMPLES) w.pulses.shift();
  }

  // Standing still on purpose is not a stall, and each of these is a different reason.
  // Named rather than folded together, because "why was it not flagged" is a question
  // somebody will ask of this instrument.
  // INERT IS NO LONGER AN UNCONDITIONAL EXCUSE.
  //
  // Standing down for a driver is right until the body is penned in AND bleeding, at which
  // point "something else is driving" has stopped being true in the only sense that
  // matters. That case is allowed through so a wedge is recorded, and the rescue in tick()
  // reads it.
  const bleedingWhileInert = at && host.inert
    && (inertBleeding(w, hp) || !!w.wedged?.inert);
  const excused = bleedingWhileInert ? null
    : !at ? 'no position'
    : host.inert ? 'inert — something else is driving'
    : host.hold ? 'holding a safe spot, which is standing still on purpose'
    : !GOING.includes(doing) ? `not going anywhere — ${doing ?? 'idle'}`
    : null;
  if (excused) {
    if (w.wedged) { w.wedged = null; }
    return null;
  }

  const [prev, last] = [w.pulses[w.pulses.length - 2], w.pulses[w.pulses.length - 1]];
  // TWO SAMPLES, A SECOND APART, AT THE SAME SQUARE. Compared on the SQUARE and not the
  // fine coordinate: a character sliding along a wall is moving in fine units and going
  // nowhere, which is precisely the bounce this is here to catch, so a fine comparison
  // would report it as healthy movement.
  const stillHere = prev && last && prev.room === last.room
    && prev.col === last.col && prev.row === last.row;
  if (!stillHere) { w.wedged = null; return null; }

  // ONE EPISODE, NOT ONE PER TICK. The alert is raised once when it starts and carries
  // its own duration afterwards, so a five-minute wedge is one thing that happened for
  // five minutes rather than three hundred identical notes.
  const takingHits = prev.health != null && last.health != null && last.health < prev.health;
  if (w.wedged) {
    w.wedged.for_ms = now - w.wedged.since;
    if (takingHits) w.wedged.taking_hits = true;
    return w.wedged;
  }
  w.wedges++;
  w.wedged = { since: prev.at, for_ms: now - prev.at, doing, inert: !!host.inert,
               at: { col: last.col, row: last.row, room: last.room },
               taking_hits: takingHits };
  host.tally.pulse_wedges = (host.tally.pulse_wedges || 0) + 1;
  // A frame, because this is the moment a post-mortem will want and the ring is
  // otherwise written on health changes — and a wedge is quiet until something finds you.
  host.recordFrame('! not moving while ' + doing);
  host.note('! NOT MOVING — ' + doing + ', same square two pulses apart', {
    square: `${last.col},${last.row}`, room: last.room,
    taking_hits: takingHits,
    health: hp ? `${hp.value}/${hp.max}` : null,
    why: 'the position pulse reads the CHARACTER on its own clock, not the keeper. Every ' +
         'other stall number here measures when the keeper last moved somebody, which ' +
         'climbs while an errand walks the character perfectly well and stays quiet ' +
         'while a wedged character is replanning into the same wall forever',
    note: 'not resting, not holding a wall, not inert — so this is standing still with ' +
          'somewhere to be. Flagged for debugging; nothing was cancelled',
  });
  return w.wedged;
}

export function tick(host) {
  const s = host.s, c = s?.client;
  if (!c || s.live !== true || c.state !== 'game') return;
  const w = host.watch;
  w.ticks++;
  const now = Date.now();
  const v = c.vitals?.();
  const hp = v?.health;

  // 1. A FRAME WHEN SOMETHING MOVED, OR WHEN NOTHING HAS FOR A WHILE.
  //
  // Gated on change rather than written every tick, because the frame ring is small and
  // a three-minute quiet travel would otherwise evict the entire run-up to the death it
  // is there to explain. A quiet walk produces one frame every WATCHDOG_FRAME_MS; a
  // character being chewed on produces one per hit, which is exactly the resolution the
  // record wants and the case the ring should be spent on.
  const changed = hp?.value != null && hp.value !== w.lastHealth;
  if (changed || now - (host.lastFrameAt ?? 0) >= WATCHDOG_FRAME_MS) {
    host.recordFrame(changed ? 'watchdog: health moved' : 'watchdog');
    w.frames++;
  }
  w.lastHealth = hp?.value ?? null;

  // 1b. THE POSITION PULSE. See PULSE_MS.
  if (now - w.lastPulseAt >= PULSE_MS) { w.lastPulseAt = now; pulse(host, now, hp); }

  // 1c. THE INERT RESCUE — taking the character back from a driver that has stopped.
  //
  // The handbrake below cancels a walk. This is the other case: something ELSE is driving,
  // the body is penned in, it is taking hits, and it is below the line this keeper flees
  // at. Standing down is the right default and it stops being right here: whatever holds
  // the character is no longer moving it, and standing still under attack is not something
  // to stand down for.
  //
  // A RESCUED JOURNEY IS PAUSED, NOT CANCELLED. Reviving hands the body to the ordinary
  // ladder, and upstream measured what that costs when the destination goes with it -- a
  // rail cancelled at 12 of 112, then zero squares in fifteen seconds while the ladder
  // cycled through refusals, then dead. So the destination is handed to the host to keep,
  // and the host is asked to mend FORWARD rather than idle where it was dying.
  //
  // Every hook here is optional: a host that cannot suspend a journey or revive simply
  // does not, and the cancel still happens. That is what lets the tick driver share this.
  const wedge = w.wedged;
  if (host.inert && wedge?.inert && wedge.taking_hits
      && (now - wedge.since) >= INERT_RESCUE_MS && w.rescuedPass !== host.passes) {
    const frac = pct(hp);
    if (frac !== null && frac < host.safety().fleeAt) {
      w.rescuedPass = host.passes;
      w.rescues = (w.rescues ?? 0) + 1;
      host.tally.inert_rescues = (host.tally.inert_rescues || 0) + 1;
      const stopped = (() => {
        try { return host.s.cancelMovement(null, 'the watchdog rescuing a stalled driver'); }
        catch (e) { return { cancelled: false, why: e.message }; }
      })();
      const was = host.inert?.why ?? 'inert';
      host.suspendJourney?.('the watchdog rescued a stalled driver');
      host.wantForwardShelter?.('the watchdog took us back from a stalled driver');
      host.revive?.('the character stopped moving and started dying while ' + was);
      host.note('WATCHDOG — took the character back from a driver that had stopped', {
        health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
        stood_down_for: was, still_ms: now - wedge.since,
        square: `${wedge.at.col},${wedge.at.row}`, room: wedge.at.room,
        interrupted: stopped.interrupted ?? null,
        why: 'not moving, being hit, and below the line this keeper flees at',
      });
      host.progress('watchdog took the character back from a stalled driver');
      return;
    }
  }

  // 1d. HOW LONG THE BODY HAS COVERED NO GROUND WHILE SUPPOSEDLY GOING SOMEWHERE.
  //
  // Kept here rather than in pulse() because it must be cleared the instant any of its
  // excuses becomes true — a character that takes a wall, or is handed to an errand, has
  // stopped being wedged at that moment and not a pulse later. Clearing on the way out is
  // what makes `pinnedSince` a duration rather than a high-water mark.
  //
  // The measure is DISPLACEMENT FROM AN ANCHOR, not stillness between samples — see
  // WATCHDOG_PINNED_SQUARES for why the obvious version of this never fired.
  const spot = w.pulses[w.pulses.length - 1] ?? null;
  const eligible = GOING.includes(host.doing ?? null) && !host.inert && !host.hold && spot;
  if (!eligible) { w.pinnedSince = null; w.pinnedAnchor = null; }
  else {
    const a = w.pinnedAnchor;
    const nearAnchor = a && a.room === spot.room
      && Math.abs((spot.col ?? 0) - a.col) <= WATCHDOG_PINNED_SQUARES
      && Math.abs((spot.row ?? 0) - a.row) <= WATCHDOG_PINNED_SQUARES;
    // Re-anchor the moment it genuinely gets somewhere. A journey that is working resets
    // this constantly and can never trip it; one that is looping never leaves the box.
    if (!nearAnchor) {
      w.pinnedAnchor = { room: spot.room, col: spot.col ?? 0, row: spot.row ?? 0 };
      w.pinnedSince = now;
    }
  }

  // 2. THE HANDBRAKE.
  const blockedFor = host.passStartedAt ? now - host.passStartedAt : 0;
  if (blockedFor > w.longest_block_ms) w.longest_block_ms = blockedFor;
  if (blockedFor < WATCHDOG_BLOCKED_MS) return;
  w.blockedSince ??= host.passStartedAt;

  // Not while something else is driving. An errand or a supply exchange owns the
  // character deliberately, and cancelling its movement from underneath it would be
  // this keeper fighting the thing it stood down for.
  if (host.inert) return;
  // Once per blocked pass. Cancelling twice does nothing useful and the note would
  // repeat every tick.
  if (w.interruptedPass === host.passes) return;

  const frac = pct(hp);
  if (frac === null) return;
  const fleeAt = host.safety().fleeAt;

  // 2b. THE SECOND ARM — WEDGED WHILE PERFECTLY HEALTHY.
  //
  // THE HOLE THIS FILLS. Everything above is gated on `frac < fleeAt`, so a character that
  // is wedged and NOT being hurt was invisible to the whole guard: the position pulse saw
  // it and said so in as many words — "Flagged for debugging; nothing was cancelled" — and
  // the handbrake returned one line later because health was fine. The only thing that ever
  // rescued a wedge was taking enough damage to be dying, which means the instrument fired
  // reliably only once it was too late to be worth firing.
  //
  // Measured on prod 2026-08-27, six characters in the Valley of Ileria: Robin at 40/40
  // spent an entire pass — 46 seconds and counting — shuffling between squares 72,65 and
  // 73,64 with two fungus beasts in swing range, 8 passes in 30 minutes against a healthy
  // keeper's 77 in 26. Nothing was hurting them, so nothing interrupted them, so the pass
  // that would have decided to fight never ended. They were not fighting because they were
  // never getting to the part where you decide to fight.
  //
  // AND THE SHUFFLE IS WHY `wedged` COULD NOT BE USED FOR THIS. That flag needs the SAME
  // square twice; two squares alternating clears it on every other sample, so the one
  // symptom that most needs catching is the one it resets on. `pennedIn` asks the question
  // the right way round — one room, within a square, over the newest three samples — and
  // CLAUDE.md has said so since the shuttle runs: a stall detector that requires stillness
  // misses the commonest way of standing still.
  //
  // IT STILL DECIDES NOTHING. Same single action as the arm below, once per pass:
  // cancelMovement, so the wedged await returns and the NEXT pass chooses with fresh
  // numbers. `host.hold` and `host.inert` are already excluded above and in pennedIn's
  // caller — a held wall is standing still on purpose and an errand is not ours to cancel.
  const pinnedFor = w.pinnedSince ? now - w.pinnedSince : 0;
  if (frac >= fleeAt) {
    if (pinnedFor < WATCHDOG_PINNED_MS) return;
    w.interruptedPass = host.passes;
    w.pinnedInterrupts++;
    // The anchor is where the wedge STARTED, which is the place to remember it by: a
    // pocket-wanderer's newest pulse moves and its anchor does not.
    const spot = w.pinnedAnchor ?? w.pulses[w.pulses.length - 1] ?? null;
    w.pinnedSince = null; w.pinnedAnchor = null;
    host.tally.watchdog_pinned_interrupts = (host.tally.watchdog_pinned_interrupts || 0) + 1;
    const broke = (() => {
      try { return s.cancelMovement(null, 'the watchdog breaking a healthy wedge'); }
      catch (e) { return { cancelled: false, why: e.message }; }
    })();
    // AND THE RECORD THAT MAKES THE NEXT DECISION DIFFERENT. See WEDGE_REPEAT_CAP: a
    // cancel alone hands the next pass the same inputs, which is a loop.
    const record = spot ? noteWedgeBreak(w, { room: spot.room, col: spot.col, row: spot.row,
                                              doing: host.doing ?? null,
                                              to: host.wedgeTarget?.() ?? null }, now) : null;
    host.note('WATCHDOG — broke a wedge that was not hurting anybody', {
      health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
      doing: host.doing ?? null,
      penned_for_s: Math.round(pinnedFor / 1000),
      pass_blocked_for_s: Math.round(blockedFor / 1000),
      square: spot ? `${spot.col},${spot.row}` : null, room: spot?.room ?? null,
      interrupted: broke.interrupted ?? null,
      repeats_here: record?.repeats ?? null, cap: WEDGE_REPEAT_CAP,
      why: 'covering no ground for ' + Math.round(pinnedFor / 1000) + 's while ' +
           (host.doing ?? 'going somewhere') + ', and full health meant nothing else here ' +
           'would ever interrupt it. The walk is cancelled so the next pass can decide ' +
           'with real numbers — this keeper does not decide anything itself',
      note: record && record.repeats >= WEDGE_REPEAT_CAP
        ? 'broken ' + record.repeats + ' times at this place — the next pass gives up rather than re-issuing the walk'
        : record && record.repeats > 1
          ? 'broken ' + record.repeats + ' times at this place — the next pass sidesteps before re-planning'
          : undefined,
    });
    host.progress('watchdog broke a healthy wedge');
    return;
  }

  w.interruptedPass = host.passes;
  w.interrupts++;
  host.tally.watchdog_interrupts = (host.tally.watchdog_interrupts || 0) + 1;
  const stopped = (() => {
    try { return s.cancelMovement(null, 'the watchdog pulling us out of a blind walk'); }
    catch (e) { return { cancelled: false, why: e.message }; }
  })();
  host.note('WATCHDOG — pulled the character out of a blind walk', {
    health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
    flee_at: Math.round(fleeAt * 100) + '%',
    pass_blocked_for_s: Math.round(blockedFor / 1000),
    interrupted: stopped.interrupted ?? null,
    why: 'the pass has been inside one await long enough to have stopped looking, and ' +
         'health crossed the withdraw threshold while it was not. The walk is cancelled ' +
         'so the next pass can decide with real numbers — this keeper does not decide ' +
         'anything itself',
  });
  host.progress('watchdog interrupted a blind walk');
}
