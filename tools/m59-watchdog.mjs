#!/usr/bin/env node
// m59-watchdog.mjs -- THE OUT-OF-BAND LIVENESS GUARD.
//
// Lifted out of m59-autopilot.mjs so both keepers share the same guard. Behaviour changes
// here therefore need matching coverage in the Autopilot copy; a guard with two subtly
// different definitions is worse than a guard in the wrong file.
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
// IT DECIDES NOTHING. Its only action is cancelMovement(): once normally, then at a
// bounded interval while the same blocked pass keeps re-arming movement, and only when
// health has crossed the withdraw line. The ordinary pass -- which already knows how to
// flee and rest -- then decides with fresh numbers. A guard that started making policy
// would be a second opinion about survival, and this repository has paid for every
// quantity that grew a second home.
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
//   host.passes         pass counter, so repeats can be identified and rate-limited
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
// If a composite starts a fresh leaf after the first cancel, keep the same blind pass
// from owning movement. Long enough for the original leaf to unwind; short enough to
// invalidate a re-armed fallback before another few hits land.
export const WATCHDOG_REPEAT_MS = Number(process.env.M59_WATCHDOG_REPEAT_MS || 1_500);
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

const pct = v => (v && v.max ? v.value / v.max : null);

// A hold object is remembered while some composite movements deliberately step away
// from it. Only the live room and square make standing still intentional. Older/generic
// hosts that expose only a boolean hold retain their previous behaviour.
function standingOnHeldSquare(host) {
  if (!host?.hold) return false;
  if (typeof host.atHold === 'function') return !!host.atHold();
  const hold = host.hold;
  if (hold.col == null || hold.row == null) return true;
  const me = host.s?.client?.self;
  if (!me || me.col !== hold.col || me.row !== hold.row) return false;
  const room = host.s?.world?.room?.num ?? host.s?.client?.room?.id ?? null;
  return hold.room == null || room == null || hold.room === room;
}

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
export function freshState() {
  return { ticks: 0, frames: 0, interrupts: 0, rescues: 0, rescuedPass: null,
           longest_block_ms: 0,
           lastHealth: null, blockedSince: null, interruptedPass: null,
           lastInterruptAt: null, interruptedDoing: null, repeatInterrupts: 0,
           pulses: [], lastPulseAt: 0, wedged: null, wedges: 0 };
}

// A repeat interrupt is much stronger than the first one. The first invalidates the
// blind leaf and lets the ordinary survival ladder decide. That ladder may start a
// perfectly healthy retreat in the SAME pass; cancelling it merely because the pass is
// still old is how a handbrake becomes the thing preventing escape.
//
// Require fresh body evidence after the first interrupt: the activity has not changed,
// and the newest three one-second pulses are still penned into one square of each other.
// A real retreat leaves that neighbourhood; the wall bounce this exists for does not.
function repeatStillWedged(host, w) {
  if (w.interruptedDoing !== (host.doing ?? null)) return false;
  const since = w.lastInterruptAt ?? Infinity;
  const after = (w.pulses ?? []).filter(p => p.at >= since);
  return pennedIn({ pulses: after });
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
  const GOING = ['travelling', 'pulling', 'converging', 'zoning'];
  const at = me ? { at: now, room: c.room?.id ?? null, col: me.col ?? null,
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
    : standingOnHeldSquare(host) ? 'holding a safe spot, which is standing still on purpose'
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

  // 2. THE HANDBRAKE.
  const blockedFor = host.passStartedAt ? now - host.passStartedAt : 0;
  if (blockedFor > w.longest_block_ms) w.longest_block_ms = blockedFor;
  // A progressing emergency retreat has its own position-based guard. The generic
  // low-health handbrake would otherwise cancel the very escape it just enabled.
  // Player danger remains able to end the journey and return control to the playbook.
  if (host.emergencyRetreat) {
    let playerThreat = false;
    try { playerThreat = (host.strangersInReach?.() ?? []).length > 0; } catch { /* optional hook */ }
    if (playerThreat) {
      host.emergencyRetreat.cancellationKind = 'player';
      host.emergencyRetreat.active = false;
      if (!host.emergencyRetreat.playerCancelIssued) {
        host.emergencyRetreat.playerCancelIssued = true;
        const stopped = (() => {
          try { return s.cancelMovement(null, 'a nearby player ended the guarded retreat'); }
          catch (e) { return { cancelled: false, why: e.message }; }
        })();
        host.note('nearby player ended the guarded retreat', {
          interrupted: stopped.interrupted ?? null,
          why: 'player danger may end a journey immediately, independently of health ' +
               'or how long the current pass has been blocked',
        });
      }
      return;
    } else if (host.emergencyRetreat.active) return;
  }
  if (blockedFor < WATCHDOG_BLOCKED_MS) return;
  w.blockedSince ??= host.passStartedAt;

  // Not while something else is driving. An errand or a supply exchange owns the
  // character deliberately, and cancelling its movement from underneath it would be
  // this keeper fighting the thing it stood down for.
  if (host.inert) return;
  const frac = pct(hp);
  if (frac === null) return;
  const fleeAt = host.safety().fleeAt;
  if (frac >= fleeAt) return;

  // One interrupt normally ends the leaf. If the SAME pass is still blocked after the
  // grace interval, it may have re-armed a nested/fallback movement with the new
  // generation. Invalidate that too, rate limited so this cannot become a tick storm.
  const repeated = w.interruptedPass === host.passes;
  if (repeated && now - (w.lastInterruptAt ?? 0) < WATCHDOG_REPEAT_MS) return;
  if (repeated && !repeatStillWedged(host, w)) return;

  w.interruptedPass = host.passes;
  w.lastInterruptAt = now;
  if (!repeated) w.interruptedDoing = host.doing ?? null;
  w.interrupts++;
  if (repeated) w.repeatInterrupts = (w.repeatInterrupts ?? 0) + 1;
  host.tally.watchdog_interrupts = (host.tally.watchdog_interrupts || 0) + 1;
  const stopped = (() => {
    try { return s.cancelMovement(null, repeated
      ? 'the watchdog cancelling movement re-armed by the same blind pass'
      : 'the watchdog pulling us out of a blind walk below the flee line'); }
    catch (e) { return { cancelled: false, why: e.message }; }
  })();
  host.note(repeated
    ? 'WATCHDOG — blind pass re-armed movement; cancelling it again'
    : 'WATCHDOG — pulled the character out of a blind walk', {
    health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
    flee_at: Math.round(fleeAt * 100) + '%',
    pass_blocked_for_s: Math.round(blockedFor / 1000),
    repeated,
    interrupted: stopped.interrupted ?? null,
    why: 'the pass has been inside one await long enough to have stopped looking, and ' +
         'health crossed the withdraw threshold while it was not. The walk is cancelled ' +
         'so the next pass can decide with real numbers — this keeper does not decide ' +
         'anything itself',
  });
  host.progress('watchdog interrupted a blind walk');
}
