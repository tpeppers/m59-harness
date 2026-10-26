// THE WATCHDOG: the 500ms clock that watches during a long await.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 7 methods: startWatchdog, pennedIn, inertBleeding, trackGrind, pulsePosition, stopWatchdog,
//   watchdogTick
import { publishCooperativePresence } from '../m59-cooperative-logoff.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { keeperOrigin, keeperRecoveryRescueReady } from '../m59-move-origin.mjs';
import { traceSurvival } from '../m59-survival-trace.mjs';
import * as watchdog from '../m59-watchdog.mjs';
import { GRIND_ALWAYS_MS, GRIND_ROWS_PER_HOUR, INERT_RESCUE_MS, PULSE_MOVEMENT_SAMPLES, PULSE_MS, PULSE_SAMPLES, WATCHDOG_BLOCKED_MS, WATCHDOG_FRAME_MS, WATCHDOG_HEALTHY_CANCEL_MS, WATCHDOG_MS, WATCHDOG_PINNED_SQUARES, WEDGE_LADDER_MS, pct } from '../m59-autopilot.mjs';
import { survivalOffOf } from '../m59-hazards.mjs';

export class WatchdogPart {
  // @part 1

  startWatchdog() {
    if (this.watchTimer) return;
    // THE SHIPPED SCRATCH IS THE SAME SCRATCH THE MODULE DEFINES, not a hand-copy of it.
    //
    // This was a literal listing fifteen fields, and `freshState()` in m59-watchdog.mjs is a
    // function whose whole stated purpose is "created here so a host cannot forget a field".
    // The two drifted the moment one gained a field: `wedgeNotedAt` was added to the module
    // and not here, so the PRODUCTION watch was missing it while the fixture that certified
    // it used `freshState()` — a test proving a guarantee that did not hold on the path that
    // matters. The copy is the bug; there is now one definition.
    //
    // The pulse ring, the pinned anchor and the wedge record are all documented there.
    this.watch = watchdog.freshState();
    this.watchTimer = setInterval(() => {
      try { this.watchdogTick(); } catch (e) { this.watch.lastError = e.message; }
    }, WATCHDOG_MS);
    this.watchTimer.unref?.();
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
  /**
   * HAS THIS BODY GONE ANYWHERE, ASKED OVER THE WHOLE RING RATHER THAN THE LAST TWO SAMPLES.
   *
   * `stillHere` compares consecutive pulses on the exact square, which is right for the
   * ordinary alarm and **blind to the two-square bounce** — and the bounce is the failure
   * this repository has spent the longest chasing. Cccc died in the Cragged Mountains with
   * its last three pulses reading 35,33 / 34,33 / 35,33: moving, by that test, between two
   * squares, for ever, with fifteen things in the room.
   *
   * So this asks the question the bounce cannot dodge — every sample in the ring, same
   * room, all within one square of the newest. A character walking somewhere leaves that
   * neighbourhood in three seconds; one oscillating never does.
   *
   * Used ONLY on the inert branch, which is the branch that acts. The ordinary alarm keeps
   * the exact-square test, because widening an instrument and widening a handbrake are
   * different decisions and only one of them has been measured.
   */
  pennedIn(w) {
    // THE NEWEST THREE, EXPLICITLY, and not "the ring" — the ring got wider so that
    // `damageRate` could see a rate, and this test gets STRICTER as it grows. Reading the
    // whole ring here would quietly demand that a character have stayed inside one square
    // for six seconds rather than three, which is a handbrake being loosened by an edit
    // that was about something else entirely.
    const ring = w.pulses.slice(-PULSE_MOVEMENT_SAMPLES);
    if (ring.length < PULSE_MOVEMENT_SAMPLES) return false;
    const last = ring[ring.length - 1];
    return ring.every(p => p.room === last.room
      && Math.abs((p.col ?? 0) - (last.col ?? 0)) <= 1
      && Math.abs((p.row ?? 0) - (last.row ?? 0)) <= 1);
  }

  /**
   * IS THIS INERT CHARACTER LOSING HEALTH WHERE IT STANDS.
   *
   * `pennedIn` for the place and the two most recent pulses for the health. Pure and free —
   * the ring is already in memory and `hp` came from the pushed vitals — because this runs
   * on every keeper in a broker holding twenty-one sessions, twice a second.
   *
   * Two samples for the health rather than one, for the same reason `stillHere` uses two: a
   * single low reading is a hit, and what this has to recognise is a character that is not
   * going anywhere while they keep landing.
   */
  inertBleeding(w, hp) {
    if (!this.pennedIn(w)) return false;
    const prev = w.pulses[w.pulses.length - 2];
    const now = hp?.value, before = prev?.health;
    return Number.isFinite(now) && Number.isFinite(before) && now < before;
  }

  // ONE SAMPLE INTO THE GRIND TRACKER, AND THE TWO JUDGEMENT CALLS IT MAKES.
  //
  // `destination` is what separates grinding from resting. A character in an inn, or holding a
  // safe wall on purpose, is stationary and CORRECT -- both look identical to a position
  // sampler, and flagging them is how an instrument earns its way into being switched off. The
  // keeper already knows the difference and calls it `doing`, so that is what is used: the
  // GOING states mean it is trying to get somewhere, anything else means it is not.
  //
  // The refusal is CONSUMED, not merely read. Leaving it set would make one refused step look
  // like an unbroken contact for as long as the character stood there, turning a two-second
  // scrape into an hour-long episode -- the exact over-reporting that would make the report
  // worthless for the question it was built for.
  trackGrind(at, doing, going) {
    if (!this.grind) return;
    const refused = this.grindRefusal; this.grindRefusal = null;
    let closed = [];
    try {
      closed = this.grind.push({
        at: at.at, room: at.room, row: at.row, col: at.col,
        refused, destination: going.includes(doing) ? (at.room ?? true) : null,
        // The keeper's own word for what it is up to, so an episode can name the intent it
        // interrupted rather than only the place. See the note in m59-wallgrind.mjs.
        doing: doing ?? null,
      });
    } catch { return; }   // instrumentation must never cost the keeper a pass
    const hour = Math.floor(Date.now() / 3600_000);
    const b = this.grindBudget;
    if (b.hour !== hour) {
      // Report what the previous hour swallowed, once, before resetting. Without this line the
      // suppression is invisible and every total downstream is quietly short.
      if (b.suppressed > 0) {
        try {
          recordEvent(this.who(), 'grind_suppressed',
                      { hour: b.hour, suppressed: b.suppressed, written: b.written,
                        why: `over the ${GRIND_ROWS_PER_HOUR}/hour budget` });
        } catch { /* never the keeper's problem */ }
      }
      b.hour = hour; b.written = 0; b.suppressed = 0;
    }
    for (const e of closed) {
      // Sub-second episodes are rounding, not evidence.
      if (!(e.ms >= 1000)) continue;
      // A LONG EPISODE IS ALWAYS WRITTEN, whatever the budget says. The budget exists to stop
      // a thousand two-second bounces, and the whole question is "is anything grinding for
      // HOURS" -- suppressing the answer to save 250 bytes would be the instrument defeating
      // its own purpose.
      if (b.written >= GRIND_ROWS_PER_HOUR && e.ms < GRIND_ALWAYS_MS) { b.suppressed += 1; continue; }
      b.written += 1;
      try {
        recordEvent(this.who(), e.kind, {
          room: e.room, row: e.row, col: e.col, ms: e.ms, samples: e.samples,
          reason: e.reason, squares: e.squares, began: e.began, ended: e.ended,
          doing: e.doing ?? null,
        });
      } catch { /* a ledger write must never cost the errand */ }
    }
  }

  pulsePosition(now, hp) {
    const w = this.watch, c = this.s?.client, me = c?.self;
    if (!w) return null;
    const doing = this.doing ?? null;
    const GOING = ['travelling', 'pulling', 'converging', 'zoning'];
    // THE ROOM NUMBER, NEVER THE ROOM OBJECT'S ID.
    //
    // `c.room.id` is a live object id. The server renumbers those on every system save,
    // alongside garbage collection, so it is not a name for a room — it is a name for a
    // handle to a room, and it is a different number after the next save.
    //
    // Two things went wrong with it here. The ring is PERSISTED into every post-mortem, so
    // a death record keyed on `1589` becomes unreadable the moment the server saves — an
    // audit of the stall decisions came back grouped as {6: 29, 1581: 5, 1589: 12}, which
    // names no room anybody can go and look at.
    //
    // And it is COMPARED: `prev.room === last.room` is half the "has this character moved"
    // test. A renumbering mid-session makes the same room look like a different one, which
    // reads as movement and silently resets the wedge detector — the exact shape of the
    // stillness bug that killed Cccc, arriving by a different door.
    //
    // `world.room.num` is the map's own number for the room. It does not move.
    // Falls back to the live handle rather than to NULL. The number is the right answer and
    // the reason for this change, but `world.room` resolves through the map and can be
    // absent — and a null here does not degrade gracefully: `prev.room === last.room` would
    // be true for every pair, so every character would read as never having changed room.
    // A stale-able id beats a field that silently makes the stall detector say yes always.
    const at = me ? { at: now, room: this.s?.world?.room?.num ?? c.room?.id ?? null, col: me.col ?? null,
                      row: me.row ?? null, x: me.x ?? null, y: me.y ?? null,
                      health: hp?.value ?? null, doing } : null;
    if (at) {
      w.pulses.push(at);
      if (w.pulses.length > PULSE_SAMPLES) w.pulses.shift();
      // Fed from the same sample rather than from its own timer: this has to agree with the
      // pulses exactly, or two instruments will describe two different walks.
      this.trackSinceFull(at, hp);
      this.trackGrind(at, doing, GOING);
    }

    // A DRIVER THAT HAS STOPPED MOVING THE CHARACTER IS NOT DRIVING IT.
    //
    // `inert` used to be excused outright, on the argument that this keeper stood down
    // deliberately and does not get to call the thing it stood down for a stall. That is
    // right about the INSTRUMENT and wrong about the RESCUE, and the difference cost two
    // characters in one leg.
    //
    // Measured on the arena fleet, 2026-08-20, walking North Barloque to Tos: Bbbb and
    // Eeee both died in The Flatlands at 28,35 and 29,35, stationary for 268 and 111
    // seconds, with four ants on them the whole time and health falling about half a point
    // a second. Both post-mortems say `stood_down_for: "travelling to The Streets of Tos"`
    // and `wedges: 0` — the position pulse, the one instrument that reads the CHARACTER's
    // own clock rather than the keeper's, was switched off by exactly the state that was
    // killing them. The keeper watched every frame of it and had nothing to say.
    //
    // So inert excuses standing still, and it does not excuse standing still WHILE LOSING
    // HEALTH. That combination is not somebody else driving; it is somebody else having
    // stopped, with the character still in the world. The wedge it opens is marked `inert`
    // and `watchdogTick` is what acts on it — this function still only ever observes.
    //
    // `doing` is deliberately not consulted on this branch: while inert the keeper sets no
    // `doing` at all, so the GOING test below would excuse it a second time.
    //
    // AND AN OPEN INERT WEDGE KEEPS IT OPEN, which is not a detail. Damage lands about once
    // a second and the pulse also runs about once a second, so half the ticks see no drop —
    // and the excused branch below CLEARS the wedge. The first version of this reset the
    // episode on every quiet tick, so it never aged past one pulse and the rescue four
    // seconds later could never fire: measured live, `wedges` climbed to 8 and `rescues`
    // stayed at 0 while the character was being eaten. A wedge ends when the body MOVES,
    // which `stillHere` below decides, and not when a single second happens to be painless.
    // AND `this.inert` ALONE WAS THE WRONG QUESTION HERE TOO — FOURTH SITE, AND IT BOUNCES.
    //
    // `drivenByOther` below, and both rescues in `watchdogTick`, have each already been
    // widened from "the keeper stood ITSELF down" to "or a commander claim holds movement".
    // This clause was left on the old test, so for a claimed character the widened rescues
    // could only ever act on a wedge the EXACT-SQUARE test opened. A body held perfectly
    // still is caught that way. A body that BOUNCES is not, and `pennedIn` — the one test
    // written for the bounce — is gated behind this flag and so never ran for them.
    //
    // MEASURED, prod 2026-09-17. Rowlf, level 52, room 39, killed by a battered skeleton:
    // `wedged_at_death.inert = "movement held by dum/prod Valley and Castle Victoria HP
    // bands@pid-38876"`, `wedges: 415`, `movement.net_squares = 1` over 94.7s, and
    // `wedged_at_death.for_ms = 1104` — the episode that killed him was 1.1 seconds old
    // because every one before it was thrown away. His last pulses read 16,8 / 17,8 / 18,8
    // and back: moving, by the exact-square test, for ever, at 41 -> 0 health. The rescue at
    // INERT_RESCUE_MS could never mature because the clock kept restarting.
    //
    // Clifford, Animal x2 the same night carry the same marker. The claim is the commonest
    // way this fleet is driven now, so the bounce case is not an edge.
    //
    // COMBAT CANNOT LEAK IN THROUGH `facultyHeld`. `facultyOwner` answers `combat:<id>` for
    // an unprotected faculty while a fight is live, which would read as a claim here — but
    // `watchdogTick` returns at `s.combat?.active` before it ever calls this, so a live
    // fight never reaches this line. Stated because the two guards are 180 lines apart and
    // nothing local says so.
    //
    // AND THE WIDENING IS TO `stillHere` ONLY — IT MUST NOT REACH THE EXCUSE LADDER.
    //
    // `bleedingWhileInert` does two jobs: it skips the ladder below, and it turns on
    // `pennedIn` in `stillHere`. Skipping the ladder is right for an INERT keeper, which
    // sets no `doing` at all and cannot be holding a wall — its own note says so. It is
    // WRONG for a claimed one: that keeper is awake, it still sets `doing`, and it can be
    // resting or holding a safe wall on purpose while a bot owns the walking. Folding the
    // claim into the same flag flagged both, and the non-travelling rescue would then have
    // cancelled movement and pulled a character OFF a wall it was deliberately holding —
    // the safe wall being the fleet's whole defensive game. Caught by the regression gate
    // in m59-claimwedge-test.mjs, which is why that gate is in it.
    //
    // So the claim gets the BOUNCE TEST and nothing else. Every excuse that applied to a
    // claimed character a moment ago still applies.
    const bleedingWhileInert = at && this.inert
      && (this.inertBleeding(w, hp) || !!w.wedged?.inert);
    const bleedingWhileClaimed = at && !this.inert && this.facultyHeld('movement')
      && (this.inertBleeding(w, hp) || !!w.wedged?.inert);
    const excused = bleedingWhileInert ? null
      : !at ? 'no position'
      : this.inert ? 'inert — something else is driving'
      : this.hold ? 'holding a safe spot, which is standing still on purpose'
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
    // The ordinary test is the exact square. The inert branch has already satisfied itself
    // with `pennedIn`, which is the wider question and the one the bounce cannot dodge —
    // see that method. Without this second clause an oscillating character reads as moving
    // and the rescue below never gets a wedge to act on.
    const stillHere = (prev && last && prev.room === last.room
                       && prev.col === last.col && prev.row === last.row)
                      || ((bleedingWhileInert || bleedingWhileClaimed) && this.pennedIn(w));
    if (!stillHere) { w.wedged = null; return null; }

    // ONE EPISODE, NOT ONE PER TICK. The alert is raised once when it starts and carries
    // its own duration afterwards, so a five-minute wedge is one thing that happened for
    // five minutes rather than three hundred identical notes.
    // AM I UNDER ATTACK IS A TREND, NOT A DIFFERENCE BETWEEN TWO SAMPLES.
    //
    // This read `last.health < prev.health` -- one adjacent pair -- and the whole wedge rescue
    // below is gated on it. Health regenerates between blows and a sample can land in the gap,
    // so a character being eaten reads as safe on any pair where the tick went up.
    //
    // MEASURED, prod 2026-09-10. Camilla, wedged in Ukgoth while `doing: travelling`, health
    // trail 20 -> 15 -> 16 -> 11 -> 7 -> 3 with fifteen threats and six trolls adjacent. The
    // 15 -> 16 step is an INCREASE, so `taking_hits` read FALSE through 20 -> 15 -> 16 -> 11 -> 7
    // and only flipped true at 3 of 60 -- one pass before she died. She lost seventeen health
    // while the thing that decides whether she was being attacked said she was not.
    //
    // The episode already knows when it began, so ask the question over the episode: is health
    // below where it was when this wedge started? That is monotonic evidence and one regen tick
    // cannot erase it. The adjacent pair is kept as an OR, because it is what catches the first
    // blow of a brand-new wedge before there is any history to trend.
    const hitNow = prev.health != null && last.health != null && last.health < prev.health;
    const startedAt = w.wedged?.health_at_start;
    const takingHits = hitNow ||
      (startedAt != null && last.health != null && last.health < startedAt);
    if (w.wedged) {
      w.wedged.for_ms = now - w.wedged.since;
      if (takingHits) w.wedged.taking_hits = true;
      // How much this episode has cost, so the rescue can say what it saw rather than just
      // that a flag was set. Camilla's postmortem showed `taking_hits: false` beside a
      // health trail that had fallen 17 points, and the two were impossible to reconcile.
      if (w.wedged.health_at_start != null && last.health != null)
        w.wedged.health_lost = Math.max(0, w.wedged.health_at_start - last.health);
      return w.wedged;
    }
    w.wedges++;
    // WHOSE STALL THIS IS — AND `inert` WAS THE WRONG QUESTION FOR HALF OF THEM.
    //
    // The rescue in `watchdogTick` is gated on this marker, and it was set only when the
    // KEEPER had stood itself down (`goInert`). That was the whole story when the only way
    // to drive a character from outside was to make its keeper inert. It is not any more: a
    // fleetscript or a bot takes `movement` with a commander claim and deliberately LEAVES
    // SURVIVAL WITH THE KEEPER — so `this.inert` is null, this marker was absent, and the
    // one mechanism that could break the wedge could never fire.
    //
    // The rescue's own comment describes exactly that case — "while something else owns the
    // character this keeper's passes finish in milliseconds, so the character bleeds out in
    // a healthy-looking keeper" — so the intent was right and only the test had gone stale.
    //
    // Measured, prod 2026-09-04. Two supply couriers died on the road to Castle Victoria
    // carrying the fleet's herbs. One record: `fled_in_time: 0.04`, and over fifty seconds
    // `gross_squares: 18, net_squares: 1, shuffled: true, rooms_crossed: 0` — oscillating
    // between two squares while a black spider ate it, health 5 -> 1 -> 1 -> 2. Every clause
    // of the rescue was satisfied except the one asking whether the keeper had gone inert,
    // which nothing in that path ever does.
    //
    // `facultyHeld` drops an expired claim on read, so a driver that has died or wandered
    // off stops counting on its own rather than pinning this open.
    const drivenByOther = this.inert ? (this.inert.why ?? 'inert')
      : (this.facultyHeld('movement') ? `movement held by ${this.facultyOwner('movement')}` : null);
    w.wedged = { since: prev.at, for_ms: now - prev.at, doing,
                 at: { col: last.col, row: last.row, room: last.room },
                 taking_hits: takingHits,
                 // The baseline for the trend above. Without it the episode can only ever
                 // compare two adjacent samples, which is the bug that killed Camilla.
                 health_at_start: last.health ?? null,
                 ...(drivenByOther ? { inert: drivenByOther } : {}) };
    this.tally.pulse_wedges = (this.tally.pulse_wedges || 0) + 1;
    // A frame, because this is the moment a post-mortem will want and the ring is
    // otherwise written on health changes — and a wedge is quiet until something finds you.
    this.recordFrame('! not moving while ' + doing);
    this.note('! NOT MOVING — ' + doing + ', same square two pulses apart', {
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

  stopWatchdog() {
    if (!this.watchTimer) return;
    clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  watchdogTick() {
    try { publishCooperativePresence(this); } catch(e) { this.watch.lastError=e.message; }
    const s = this.s, c = s?.client;
    if (!c || s.live !== true || c.state !== 'game') return;
    if (s.combat?.active) { if (this.watch) this.watch.lastSkip = { at: Date.now(), why: 'combat mode owns the body' }; void s.combat.tick(); return; }
    const w = this.watch;
    const now = Date.now();
    const v = c.vitals?.();
    const hp = v?.health;
    // SURVIVAL OFF STILL WRITES FRAMES. It used to return before the frame, so a character stood down by the operator
    // died with a trail that had stopped minutes earlier and read as a keeper that could not hear its own health
    // (Rowlf and Clifford, prod 2026-10-26: health pushes for every hit, no frame, no flee). Observing is not
    // intervening: the frame is written, and nothing else here runs.
    if (survivalOffOf(this.policy)) {
      if (!w) return;
      const moved = hp?.value != null && hp.value !== w.lastHealth;
      if (moved || now - (this.lastFrameAt ?? 0) >= WATCHDOG_FRAME_MS) this.recordFrame(moved ? 'watchdog: health moved (survival OFF)' : 'watchdog (survival OFF)');
      w.lastHealth = hp?.value ?? null;
      w.lastSkip = { at: now, why: 'survival disabled by operator' };
      return;
    }
    w.ticks++;
    w.lastTickAt = now;

    // 1. A FRAME WHEN SOMETHING MOVED, OR WHEN NOTHING HAS FOR A WHILE.
    //
    // Gated on change rather than written every tick, because the frame ring is small and
    // a three-minute quiet travel would otherwise evict the entire run-up to the death it
    // is there to explain. A quiet walk produces one frame every WATCHDOG_FRAME_MS; a
    // character being chewed on produces one per hit, which is exactly the resolution the
    // record wants and the case the ring should be spent on.
    const changed = hp?.value != null && hp.value !== w.lastHealth;
    if (changed || now - (this.lastFrameAt ?? 0) >= WATCHDOG_FRAME_MS) {
      this.recordFrame(changed ? 'watchdog: health moved' : 'watchdog');
      w.frames++;
    }
    // How much went this tick, read BEFORE the memory is overwritten — the fight-back edict
    // below asks it, and asking after the assignment always answers zero.
    const lostThisTick = (hp?.value != null && w.lastHealth != null && hp.value < w.lastHealth)
      ? w.lastHealth - hp.value : 0;
    w.lastHealth = hp?.value ?? null;
    // 1b. THE POSITION PULSE. See PULSE_MS.
    if (now - w.lastPulseAt >= PULSE_MS) { w.lastPulseAt = now; this.pulsePosition(now, hp); }
    // Keep evidence fresh, but give no action edict a turn during a valid freeze.
    // This clock still runs while a pass is waiting for stats or a mover to unwind.
    if (this.checkFreeze()) return;

    // 1b'. THE FIGHT-BACK EDICT — under attack, not swinging, and told to. See fightBackCheck.
    this.fightBackCheck(w, hp, now, lostThisTick);

    // 1b''. THE PATH-CLEARING EDICT — covering no ground with something in reach. Runs AFTER
    // the damage edict on purpose: being hit is the stronger signal and should win the pass.
    this.clearPathCheck(w, hp, now);

    // 1c. TAKE THE CHARACTER BACK FROM A DRIVER THAT HAS STOPPED DRIVING IT.
    //
    // The handbrake below cannot reach this case and never could: it is armed by the
    // KEEPER's pass being stuck inside one await, and while something else owns the
    // character this keeper's passes finish in milliseconds. So the character bleeds out
    // in a healthy-looking keeper. See the measurement in `pulsePosition`.
    //
    // Every clause is load-bearing, and together they say "not moving, being hit, and
    // already past the line at which this keeper would run away on its own account":
    //
    //   * an INERT wedge, which is the pulse's own answer about the body rather than a
    //     number about the keeper;
    //   * still open for INERT_RESCUE_MS, so a driver pausing at a door is left alone;
    //   * `taking_hits`, so a character standing still safely is left alone;
    //   * below `safety().fleeAt`, the same threshold the keeper uses for itself.
    //
    // What it does is the least it can: cancel the movement and stop being inert. It
    // decides NOTHING — the next ordinary pass runs the survival ladder with real numbers,
    // exactly as it would have if nothing had ever taken the character. That is the same
    // contract the handbrake has, and the reason both are safe.
    //
    // AND IT IS THE PROTECTED FACULTY DOING IT, not a policy. Survival is refused to a bot
    // unless the roster consents (PROTECTED_FACULTIES); a keeper that stood down for an
    // errand and then watched the character die had given it away anyway.
    const wedge = w.wedged;
    // A WEDGED ERRAND IS RESCUED. A WEDGED JOURNEY IS NOT CANCELLED.
    //
    // The operator's rule again — death or a player, nothing else stops a trip — and this
    // was the last thing in the file still breaking it. Measured on the two most recent
    // journeys before this change, both of which ended here:
    //
    //     599 -> 2    FAIL  movement cancelled by the watchdog rescuing a stalled driver
    //     587 -> 597  FAIL  movement cancelled by the watchdog rescuing a stalled driver
    //
    // and the rung's OWN comment, written after an earlier death, already says what the
    // cancel costs: "measured in Ukgoth, the rail was cancelled at 12 of 112 by the watchdog
    // rescuing a stalled driver and the character then walked ZERO squares in fifteen
    // seconds while the ladder ran through 'could not reach the safe spot', 'will not rest
    // in the open here', 'leaving the room to recover safely', 'could not leave' — and died."
    // It was known to be lethal and kept because nothing had connected it to the rule.
    //
    // AND THE WEDGE IT ANSWERS HAS LARGELY BEEN FIXED AT ITS SOURCE. The blind grinding this
    // used to catch was `walkFine` aiming at a bearing over a distance — nine tenths of the
    // packets in Ukgoth refused, the body creeping sideways along a wall. That walker now
    // follows a planned route, and the same crossing went from 107 seconds to 15.
    //
    // An ERRAND is a different case and keeps its rescue: something else is driving, it has
    // stopped moving the body, and there is no destination being thrown away by stepping in.
    const travelling = !!this.inert?.travelling;
    // SAME GATE CHANGE, AND THIS HALF IS THE OBSERVABILITY. This is the note that says a wedge
    // was SEEN and the journey is deliberately standing. It was gated on `inert` too, so
    // Camilla's thirty-four-minute wedge in Ukgoth produced no note at all -- the postmortem
    // has forty-eight position pulses and not one line saying she was stuck while travelling.
    // A decision not to act still has to be recorded, or the absence of a rescue is
    // indistinguishable from the absence of a problem.
    if (travelling && wedge && wedge.taking_hits
        && keeperRecoveryRescueReady(this.s,wedge.since,now,INERT_RESCUE_MS) && w.rescuedPass !== this.passes
        && !w.saidTravelWedge) {
      w.saidTravelWedge = true;
      // NOT the moment to cancel the walk, even in a crowd. Tried on tour 16 (2026-09-03):
      // cancelling here ENDS a runner-driven journey ("no longer travelling"), and the body
      // was left standing in the crowd with nothing to do, which is the death it was meant
      // to prevent. A wedge in a crowd is left by the exit from the journey ATTEMPT — when
      // the arm gives up — where the retreat and the re-plan belong to the same pass.
      this.note('wedged mid-journey, and the journey stands', {
        wedged_for_s: Math.round((now - wedge.since) / 1000),
        health: hp?.value == null ? null : `${hp.value}/${hp.max}`,
        why: 'only a death or a player ends a trip. Cancelling this is what put a character ' +
             'in Ukgoth that walked zero squares in fifteen seconds and died — the mover is ' +
             'left to unstick itself, which is now a planned route rather than a bearing',
      });
    }
    // ...UNLESS IT IS DYING, WHICH IS THE ONE THING THE STANDING RULE ALREADY EXCEPTS.
    //
    // "The journey stands" is right for a wedge, and this file has the deaths to prove that
    // cancelling one is worse. But the rule it is derived from was corrected on 2026-08-21
    // and the correction is the half that was missing here: walking THROUGH is the answer to
    // being hit, and it is NOT the answer to being below the flee line. That is the Cccc
    // lesson — walked out of a sanctuary at 27% and eaten in twenty-two seconds — and a
    // wedged journey is the same picture with the walking removed.
    //
    // Measured, prod 2026-09-04: two couriers carrying the fleet's entire herb supply died
    // on the road to Castle Victoria. One went 5 -> 1 -> 1 -> 2 health while `gross_squares
    // 18, net_squares 1, shuffled: true` — fifty seconds oscillating between two squares —
    // and `travel_arm: null`, so the journey's own guard was not armed either. It had no
    // mechanism at all: the guard was absent and the watchdog was standing off.
    //
    // SUSPENDED, NOT CANCELLED, which is what keeps the standing rule intact. The destination
    // is kept in `suspendedJourney` and `resumeSuspendedJourney` puts the character back on
    // the same line once it is well enough to walk it — the trip is interrupted, not ended,
    // exactly as a travel-guard take-back interrupts one.
    // AND `inert` IS NO LONGER PART OF THE GATE. THIRD TIME THIS CLAUSE HAS PRODUCED A CORPSE.
    //
    // The note above already records the first two corrections: the marker was set only when
    // the KEEPER had stood itself down, then extended to cover another driver holding movement.
    // Neither covers a journey the keeper is running ITSELF with nobody holding anything -- and
    // that is the commonest journey there is.
    //
    // MEASURED, prod 2026-09-10. Camilla died in Ukgoth `doing: travelling`, at r51c19, with
    // fifteen threats and six trolls adjacent, `ms_since_moved: 2029414` -- THIRTY-FOUR MINUTES
    // on one square -- health falling 20 -> 15 -> 16 -> 11 -> 7 -> 3, and no rescue ever fired.
    // Her faculties had been released minutes earlier when a fleet errand refused her, so
    // `this.inert` was null and `facultyHeld('movement')` was false: the clause could not be
    // true, so the other three never got asked. Rizzo died 83 seconds earlier in the same room
    // and WAS rescued (`was_inert_for_s: 74`) because something still held his movement. Same
    // room, same trolls, same code -- and the one that nobody was driving is the one that had
    // no mechanism.
    //
    // The remaining three conditions are not weak. A character that is TRAVELLING, has not
    // moved for INERT_RESCUE_MS, is LOSING HEALTH across the episode, and is BELOW ITS OWN FLEE
    // LINE is not an ambiguous state, and who happens to own its movement does not change what
    // should be done about it. `inert` is still recorded on the wedge, because knowing which
    // driver was holding a dying character is worth having in the postmortem -- it is just not
    // a precondition for saving it.
    if (travelling && wedge && wedge.taking_hits
        && keeperRecoveryRescueReady(this.s,wedge.since,now,INERT_RESCUE_MS) && w.rescuedJourney !== this.inert) {
      const frac = pct(hp);
      if (frac !== null && frac < this.safety().fleeAt) {
        w.rescuedPass = this.passes;
        w.rescuedJourney = this.inert;
        this.survivalInterruptedPass = this.passes;
        w.rescues = (w.rescues ?? 0) + 1;
        this.tally.wedged_journey_rescues = (this.tally.wedged_journey_rescues || 0) + 1;
        const journey = this.travelling;
        this.suspendJourney('wedged below the flee line while travelling');
        try { this.cancelForSurvival(null, 'wedged below the flee line while travelling', { origin: keeperOrigin('watchdog') }); } catch {}
        // Mend at a wall FORWARD on the route rather than idling where it was dying — the
        // same landing the watchdog's other rescue takes, and for the same reason.
        this.wantsForwardShelter = 'wedged below the flee line while travelling';
        if (this.inert) this.revive('wedged below the flee line while travelling');
        this.note('WEDGED AND DYING MID-JOURNEY — the trip is suspended, not ended', {
          health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
          flee_at: Math.round(this.safety().fleeAt * 100) + '%',
          still_ms: now - wedge.since, resume_to: journey?.to ?? null,
          why: 'walking through is the answer to being hit, not to being below the flee ' +
               'line. The destination is kept and resumed once it can walk again',
        });
      }
    }
    // A CLAIMED MOVER COUNTS AS A DRIVER. `this.inert` alone asked whether the keeper had
    // stood ITSELF down, which is one of the two ways a character gets driven now — the
    // other is a commander claim on `movement`, which leaves survival here on purpose. Both
    // produce the same picture from this side: something else owns the walking, it has
    // stopped, and the body is being hit. See the wedge marker above for the measurement.
    const heldByOther = !!this.inert || this.facultyHeld('movement');
    if (!travelling && heldByOther && wedge?.inert && wedge.taking_hits
        && keeperRecoveryRescueReady(this.s,wedge.since,now,INERT_RESCUE_MS) && w.rescuedPass !== this.passes) {
      const frac = pct(hp);
      if (frac !== null && frac < this.safety().fleeAt) {
        w.rescuedPass = this.passes;
        this.survivalInterruptedPass = this.passes;
        w.rescues = (w.rescues ?? 0) + 1;
        this.tally.inert_rescues = (this.tally.inert_rescues || 0) + 1;
        const stopped = (() => {
          try { return this.cancelForSurvival(null, 'the watchdog rescuing a stalled driver', { origin: keeperOrigin('watchdog') }); } catch (e) { return { cancelled: false, why: e.message }; }
        })();
        const was = this.inert?.why ?? `movement held by ${this.facultyOwner('movement')}`;
        // A RESCUED JOURNEY IS PAUSED, NOT CANCELLED.
        //
        // `revive` drops the objective and hands the body to the ordinary ladder. For an
        // ERRAND that is right — somebody else was driving and the errand is off. For a
        // JOURNEY it is how a character ends up standing in a troll den with nothing
        // permitted: measured in Ukgoth, the rail was "cancelled at 12 of 112 by the
        // watchdog rescuing a stalled driver" and the character then walked ZERO squares in
        // fifteen seconds while the ladder ran through "could not reach the safe spot", "will
        // not rest in the open here", "leaving the room to recover safely", "could not leave"
        // — and died.
        //
        // The rescue is still right: something was hitting it and the mover was not
        // answering. What is wrong is throwing the destination away with the driver. Kept
        // here the same way a travel-guard take-back keeps it, so `resumeSuspendedJourney`
        // puts the character back on the same line once it is well enough to walk it.
        const journey = this.travelling;
        if (journey?.to != null) {
          this.suspendedJourney ??= {
            to: journey.to, why: journey.why ?? 'travelling', at: Date.now(),
            trigger: 'the watchdog rescued a stalled driver',
            attempts: (journey.attempts ?? 0) + 1,
            deaths_at: this.tally?.deaths ?? 0,
          };
        }
        // AND IT MUST NOT BE LEFT IDLE WHERE IT WAS DYING. Reviving hands the body to the
        // ordinary ladder, which in a bad room has nothing to offer — Aaaa's journey ended at
        // two legs, it went idle at +81s and was dead at 201s. The next pass now takes a wall
        // FORWARD on the route and mends there, with the destination kept.
        this.wantsForwardShelter = 'the watchdog took us back from a stalled driver';
        // `revive` only means anything to a keeper that stood ITSELF down. When the mover is
        // held by a commander claim there is nothing to revive — the keeper has been awake
        // the whole time — and the cancel above is the whole rescue: it frees the mover so
        // this keeper's own survival ladder can walk the body on the very next pass. The
        // claim is deliberately LEFT ALONE: taking ownership back is the operator's call
        // (`autopilot action=release`), and survival never needed it to act.
        if (this.inert) this.revive('the character stopped moving and started dying while ' + was);
        else this.note('WATCHDOG — the mover was claimed and had stopped; cancelled its walk', {
          held_by: this.facultyOwner('movement'), still_ms: now - wedge.since,
          health: hp?.value == null ? null : `${hp.value}/${hp.max}`,
          why: 'survival stays with the keeper under a claim, so the ladder can move this ' +
               'body the moment the walk it was pinned behind is cancelled. The claim stands',
        });
        this.note('WATCHDOG — took the character back from a driver that had stopped', {
          health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
          flee_at: Math.round(this.safety().fleeAt * 100) + '%',
          stood_down_for: was, still_ms: now - wedge.since,
          square: `${wedge.at.col},${wedge.at.row}`, room: wedge.at.room,
          interrupted: stopped.interrupted ?? null,
          why: 'not moving, being hit, and below the line this keeper flees at. Whatever ' +
               'was driving is no longer moving the character, and standing still under ' +
               'attack is not something to stand down for',
          note: 'the walk is cancelled and this keeper is no longer inert — the next pass ' +
                'decides, with real numbers. Nothing is decided here',
        });
        w.wedged = null;
      }
    }

    // 1d. HOW LONG THE BODY HAS COVERED NO GROUND WHILE SUPPOSEDLY GOING SOMEWHERE.
    //
    // DISPLACEMENT FROM AN ANCHOR, not stillness between samples. `pennedIn` asks whether
    // the newest samples sit within a square of EACH OTHER, which a wander defeats: every
    // few samples look like movement and the timer resets before it can mature. Anchoring
    // asks the question that cannot be dodged — where were we when this started, and are we
    // still there.
    //
    // Cleared here rather than in the pulse so that taking a wall, or being handed to an
    // errand, ends the episode at that instant instead of a pulse later.
    const spot = w.pulses[w.pulses.length - 1] ?? null;
    const goingSomewhere = ['travelling', 'pulling', 'converging', 'zoning']
      .includes(this.doing ?? null);
    if (!(goingSomewhere && !this.inert && !this.hold && spot)) {
      w.pinnedSince = null; w.pinnedAnchor = null;
    } else {
      const a = w.pinnedAnchor;
      const near = a && a.room === spot.room
        && Math.abs((spot.col ?? 0) - a.col) <= WATCHDOG_PINNED_SQUARES
        && Math.abs((spot.row ?? 0) - a.row) <= WATCHDOG_PINNED_SQUARES;
      // Re-anchor the moment it genuinely gets somewhere: a journey that is working resets
      // this constantly and can never trip it, while one going in circles never leaves.
      if (!near) {
        w.pinnedAnchor = { room: spot.room, col: spot.col ?? 0, row: spot.row ?? 0 };
        w.pinnedSince = now;
      }
    }

    // 2. THE HANDBRAKE.
    const blockedFor = this.passStartedAt ? now - this.passStartedAt : 0;
    if (blockedFor > w.longest_block_ms) w.longest_block_ms = blockedFor;
    if (blockedFor < WATCHDOG_BLOCKED_MS) return;
    w.blockedSince ??= this.passStartedAt;

    // Not while something else is driving. An errand or a supply exchange owns the
    // character deliberately, and cancelling its movement from underneath it would be
    // this keeper fighting the thing it stood down for.
    if (this.inert) return;
    // ONCE PER BLOCKED PASS — AND ONCE WAS ONLY EVER ENOUGH IF IT WORKED.
    //
    // "Cancelling twice does nothing useful" is true of the LEVER: cancelling a cancelled
    // walk is a no-op. It is not true of the SITUATION when the pass is blocked on something
    // `cancelMovement` cannot free, because then the pass never ends and this guard means
    // "never again". Robin, prod 2026-09-19: 533 seconds of a 534-second pass inside one
    // rung, killed in it, and this line entitled the watchdog to act once in nine minutes.
    //
    // Re-arms on BOTH conditions, never one. Health still falling since the last interrupt is
    // what separates "the first interrupt did not work" from "it worked and this pass is
    // legitimately long" — without it, every slow town trip would be interrupted on a timer.
    if (w.interruptedPass === this.passes) {
      if (!watchdog.mayReinterrupt({ now, interruptedAt: w.interruptedAt,
                                     interruptedAtHealth: w.interruptedAtHealth,
                                     health: hp?.value ?? null })) return;
      this.tally.watchdog_reinterrupts = (this.tally.watchdog_reinterrupts || 0) + 1;
    }

    const frac = pct(hp);
    if (frac === null) return;
    const fleeAt = this.safety().fleeAt;

    // 2b. THE SECOND ARM — WEDGED WHILE PERFECTLY HEALTHY.
    //
    // Everything below is gated on `frac < fleeAt`, so a character wedged and NOT being
    // hurt was invisible to this entire guard: the pulse saw it, said so, and cancelled
    // nothing, and the handbrake returned one line later because health was fine. The only
    // thing that ever broke a wedge was taking enough damage to be dying — which means the
    // instrument fired reliably only once it was too late to be worth firing.
    //
    // Measured on prod 2026-08-27, Rowlf in Castle Victoria: `doing: zoning`, ONE pass for
    // four and a half minutes (`blocked_now_ms: 283580`), 81 pulse wedges, and zero
    // interrupts, while sitting on squares 24,3 · 24,4 · 24,5 · 25,3 at full health. Room 38
    // has four separate doors into room 39 — one per side of a split room — so plain travel
    // walks between candidate doors and never commits. Nothing was hurting him, so nothing
    // stopped him, so the pass that would have re-decided never ended.
    //
    // IT STILL DECIDES NOTHING. Same single action as the arm below, once per pass:
    // cancelMovement, so the wedged await returns and the NEXT pass chooses with fresh
    // numbers. Holding a wall and being inert are already excluded above.
    const pinnedFor = w.pinnedSince ? now - w.pinnedSince : 0;
    if (frac >= fleeAt) {
      // TWO DECISIONS, NOT ONE. Recording that this place is a wedge is what lets
      // `answerWedge` climb the escape ladder; cancelling the walk is a separate, more
      // expensive act that an operator may switch off. This arm used to do both behind a
      // single `if`, so turning cancels off turned the ladder off with them — silently,
      // for healthy characters only, which is the population it exists for. See
      // WEDGE_LADDER_MS in m59-watchdog.mjs.
      if (pinnedFor < WEDGE_LADDER_MS) return;
      // Paced on its own clock rather than by clearing `pinnedSince`. The anchor's age is
      // what `wedgedInPlace` reads for the survival rungs; resetting it here every ten
      // seconds would mean it never reached WATCHDOG_PINNED_MS and those rungs would never
      // fire again — the same shape of accident this whole change is repairing.
      const cancelling = pinnedFor >= WATCHDOG_HEALTHY_CANCEL_MS;
      // PACED ONLY WHERE THE ANCHOR IS NOT CLEARED. A cancel sets `pinnedSince` to null, so
      // the next record already cannot arrive until the body has been pinned a further
      // WEDGE_LADDER_MS — the cadence is self-limiting on that path and this clock would be
      // a second, redundant limiter on it. On the record-only path nothing clears the
      // anchor, `pinnedFor` keeps growing, and without this every tick would write a record:
      // WEDGE_REPEAT_CAP reached in two and a half seconds of ordinary slow walking.
      if (!cancelling && w.wedgeNotedAt && now - w.wedgeNotedAt < WEDGE_LADDER_MS) return;
      w.wedgeNotedAt = now;
      // The anchor is where the wedge STARTED, which is the place to remember it by: a
      // pocket-wanderer's newest pulse moves and its anchor does not.
      const place = w.pinnedAnchor ?? spot ?? null;
      if (cancelling) {
        w.interruptedPass = this.passes;
        // WHAT THE RE-ARM COMPARES AGAINST. See the guard at the top of this method: a second
        // interrupt inside one pass needs to know when the first one was and how healthy the
        // body was then, or "is it still getting worse" cannot be asked.
        w.interruptedAt = now;
        w.interruptedAtHealth = hp?.value ?? null;
        w.pinnedInterrupts = (w.pinnedInterrupts ?? 0) + 1;
        w.pinnedSince = null; w.pinnedAnchor = null;
        this.tally.watchdog_pinned_interrupts = (this.tally.watchdog_pinned_interrupts || 0) + 1;
      }
      // A COUNTER FOR THE THING THAT NOW HAPPENS. With cancels off,
      // `watchdog_pinned_interrupts` stays 0 forever while this arm records every
      // WEDGE_LADDER_MS, so the only evidence the ladder is being fed at all was the note.
      this.tally.watchdog_wedges_recorded = (this.tally.watchdog_wedges_recorded || 0) + 1;
      const broke = cancelling ? (() => {
        try { return this.s.cancelMovement(null, 'the watchdog breaking a healthy wedge', { origin: keeperOrigin('watchdog') }); }
        catch (e) { return { cancelled: false, why: e.message }; }
      })() : { cancelled: false, interrupted: null,
               why: 'cancels are off here; this arm is recording the wedge so the ladder can run' };
      // AND THE RECORD THAT MAKES THE NEXT DECISION DIFFERENT. "The next pass can decide
      // with real numbers" was the claim, and the numbers were identical — same square,
      // same room, same destination — so the next pass re-issued the same walk and this arm
      // broke it again: 589 times in 93 minutes on one character, and 18 minutes on one
      // square with seven threats in the room on the same character, who then died mid-
      // "travel". `answerWedge` reads this before the next walk is issued. See
      // WEDGE_REPEAT_CAP in m59-watchdog.mjs.
      const record = place ? watchdog.noteWedgeBreak(w, { room: place.room, col: place.col, row: place.row,
                                                          doing: this.doing ?? null,
                                                          to: this.wedgeTarget() }, now) : null;
      this.note(cancelling ? 'WATCHDOG — broke a wedge that was not hurting anybody'
                           : 'WATCHDOG — recorded a wedge that was not hurting anybody', {
        cancelled: cancelling,
        health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
        doing: this.doing ?? null,
        penned_for_s: Math.round(pinnedFor / 1000),
        pass_blocked_for_s: Math.round(blockedFor / 1000),
        square: place ? `${place.col},${place.row}` : null, room: place?.room ?? null,
        interrupted: broke.interrupted ?? null,
        repeats_here: record?.repeats ?? null, cap: watchdog.WEDGE_REPEAT_CAP,
        why: 'covering no ground for ' + Math.round(pinnedFor / 1000) + 's while ' +
             (this.doing ?? 'going somewhere') + ', and full health meant nothing else here ' +
             'would ever interrupt it. The walk is cancelled so the next pass can decide ' +
             'with real numbers — this keeper does not decide anything itself',
        note: record && record.repeats >= watchdog.WEDGE_REPEAT_CAP
          ? 'broken ' + record.repeats + ' times at this place — the next pass gives up rather than re-issuing the walk'
          : record && record.repeats > 1
            ? 'broken ' + record.repeats + ' times at this place — the next pass sidesteps before re-planning'
            : undefined,
      });
      if (cancelling) this.progress('watchdog broke a healthy wedge');
      return;
    }

    // OFF, AND NOT COMING BACK. Operator's instruction, 2026-08-27, in his words: "My bots
    // either complete their travel orders, get interrupted by PVP, or die."
    //
    // This rung cancels a walk whenever health is under the flee line and the pass has been
    // inside one await for three seconds. On an ordinary road that is most of a crossing, and
    // the corridor at row 29 of the Western border of the Twisted Wood is the proof: with
    // eight bodies parked along it, four separate live crossings were cut off after TWO OR
    // THREE STEPS, every one of them by this line. Held off, the same walk ran nineteen.
    //
    // It is the last hole in the road doctrine. `travel_guard` was narrowed to a person and
    // dying; `retreat_to_inn` was switched off; the flee rung was removed years-of-commits
    // ago — and then this cancelled the walk anyway, from a completely different code path,
    // on a threshold none of those settings can see. A doctrine with an exception nobody
    // configured is not a doctrine.
    //
    // WHAT REPLACES IT IS NOT NOTHING. Being hurt on a road already has an answer, and it is
    // the one the operator specified: the next route-adjacent safe spot, play dead once, rest
    // to full, carry on, objective kept. That runs on the keeper's own clock and does not
    // need the walk torn down to happen.
    //
    // The pinned-wedge half above is untouched: it fires at FULL health on a character that
    // has covered no ground for minutes, which is a stuck bot rather than a hurt one, and
    // nothing else in the file interrupts it.
    //
    // Kept rather than deleted, because a behaviour that is gone cannot be measured again.
    // `blind_walk_watchdog: true` restores it per character.
    if (this.policy.blindWalkWatchdog !== true) {
      traceSurvival(s, 'blind_walk_watchdog_disabled', { health_fraction: frac,
        flee_at: fleeAt, pass_blocked_ms: blockedFor }, { throttle_ms: 10_000 });
      this.progress('travelling — hurt, and the walk stands');
      return;
    }
    w.interruptedPass = this.passes;
    w.interruptedAt = now;
    w.interruptedAtHealth = hp?.value ?? null;
    w.interrupts++;
    this.tally.watchdog_interrupts = (this.tally.watchdog_interrupts || 0) + 1;
    const stopped = (() => {
      try { return this.cancelForSurvival(null, 'the watchdog pulling us out of a blind walk below the flee line', { origin: keeperOrigin('watchdog') }); } catch (e) { return { cancelled: false, why: e.message }; }
    })();
    this.note('WATCHDOG — pulled the character out of a blind walk', {
      health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
      flee_at: Math.round(fleeAt * 100) + '%',
      pass_blocked_for_s: Math.round(blockedFor / 1000),
      interrupted: stopped.interrupted ?? null,
      why: 'the pass has been inside one await long enough to have stopped looking, and ' +
           'health crossed the withdraw threshold while it was not. The walk is cancelled ' +
           'so the next pass can decide with real numbers — this keeper does not decide ' +
           'anything itself',
    });
    this.progress('watchdog interrupted a blind walk');
  }
  // @end 1
}
