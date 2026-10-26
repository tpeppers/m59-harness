// WEDGES AND BLOCKERS: being stuck in place, answering it, and luring a spared blocker away.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 22 methods: wedgeTarget, wedgePlace, wedgeHere, wedgedInPlace, measuredWedgeInPlace, stuckRung,
//   backUpToUnstick, wedgeBlink, doorNear, answerWedge, defensiveAnswer, escapeIfWedgedAndHurt,
//   observeBlockerLure, blockerEvent, blockerPathClear, finishClearedBlocker, tradeInPlaceIfWedged,
//   planBlockerLure, sparedHere, lureSparedBlocker, notePassSucceeded, notePassFailed
import { blockerRetaliated, lureRefugeFilter } from '../m59-blocker-combat.mjs';
import { recordBlockerClearance } from '../m59-blocker-events.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { isTerminalMovementReason } from '../m59-movement.mjs';
import { OF } from '../m59-parse.mjs';
import { recoveryRefugeReach } from '../m59-recovery-refuge.mjs';
import { coarseCombatReachFrom } from '../m59-safespots.mjs';
import { endProvoke, grantProvoke, isSpared } from '../m59-spare.mjs';
import { loadSpawns } from '../m59-spawns.mjs';
import { currentSurvivalDecision, finishSurvivalDecision } from '../m59-survival-decision.mjs';
import { sameJamPocket } from '../m59-survival-jam.mjs';
import * as watchdog from '../m59-watchdog.mjs';
import { BLINK_MANA, REACH, SPARE_LURES_PER_ROOM, SPARE_LURE_WINDOW_MS, SPAWN_FILE, WATCHDOG_PINNED_MS, WEDGE_BLINK_COOLDOWN_MS, WEDGE_BLINK_DOOR_SQUARES, WEDGE_BLINK_MIN_HEALTH, WEDGE_SIDESTEPS, pct, vigorOf } from '../m59-autopilot.mjs';

export class WedgePart {
  // @part 1

  // ------------------------------------------------------------ the wedge, answered
  //
  // THE PASS'S HALF OF THE WEDGE-BREAK. The second arm above records where it broke a
  // wedge and how many times running it has broken one at that place; nothing in the
  // watchdog decides anything, and that is still true. These are what the PASS does with
  // the record, which is the part that was missing: without it the next pass re-decided
  // from the same square with the same destination, issued the same walk, and the arm
  // broke it again, for hours. The argument and the two incidents are beside
  // WEDGE_REPEAT_CAP in m59-watchdog.mjs; the guard is m59-wedge-test.mjs.

  // The objective, for the record: a journey's destination if one is in flight.
  wedgeTarget() { return this.travelling?.to ?? null; }

  // Where the body is, in the terms the record is kept in. Null when nobody knows.
  wedgePlace() {
    const c = this.s?.client, me = c?.self;
    const room = this.s?.world?.room?.num ?? c?.room?.id ?? null;
    if (!me || room == null || me.col == null || me.row == null) return null;
    return { room, col: me.col, row: me.row };
  }

  // The record, if it is about HERE. A record about somewhere else means the body has got
  // somewhere since, so the wedge is over, and it is dropped so the next one counts from
  // one. A record with no known position is left alone: "I do not know where I am" is not
  // evidence of having moved.
  wedgeHere(now = Date.now()) {
    const w = this.watch;
    if (!w?.wedgeBreak) return null;
    const here = this.wedgePlace();
    if (!here) return null;
    const advice = watchdog.wedgeAdvice(w, here, now);
    if (!advice) { w.wedgeBreak = null; this.wedgeHold = null; }
    return advice;
  }

  // IS THE BODY WEDGED WHERE IT STANDS — asked by the ladder, which needs a yes before it
  // will spend a rung on something other than movement. Any of four signals says yes: the
  // arm has broken a walk at this place, the pass has given up walking from it, the pulse
  // has seen the same square for WATCHDOG_PINNED_MS, or the pinned anchor has aged that
  // long. The last two are here because the first two need the arm to have FIRED, and the
  // arm is gated on full health: a character being eaten on one square for eighteen
  // minutes never tripped it, and that is the incident this exists for.
  wedgedInPlace(now = Date.now()) {
    const e=this.survivalJam(now);
    if(e?.measured)return {why:'survival-owned jam',for_ms:now-e.at,repeats:e.failures,episode_id:e.id};
    return this.measuredWedgeInPlace(now);
  }

  measuredWedgeInPlace(now = Date.now()) {
    const w = this.watch;
    if (!w) return null;
    const here = this.wedgePlace();
    const b = w.wedgeBreak;
    if (b && here && watchdog.sameWedgePlace(b, here))
      return { why: b.repeats + ' walk(s) cancelled here', for_ms: now - b.first_at, repeats: b.repeats };
    const h = this.wedgeHold;
    if (h && here && watchdog.sameWedgePlace(h, here) && now < h.until)
      return { why: 'gave up walking from here', for_ms: now - h.at, repeats: h.repeats };
    if (w.wedged && now - w.wedged.since >= WATCHDOG_PINNED_MS)
      return { why: 'same square for ' + Math.round((now - w.wedged.since) / 1000) + 's',
               for_ms: now - w.wedged.since, repeats: 0 };
    if (w.pinnedSince && now - w.pinnedSince >= WATCHDOG_PINNED_MS)
      return { why: 'covered no ground for ' + Math.round((now - w.pinnedSince) / 1000) + 's',
               for_ms: now - w.pinnedSince, repeats: 0 };
    return null;
  }

  // ASKED BY `travel()` BEFORE IT SETS OUT, so a walk issued from a place the arm has
  // already broken one at starts from somewhere else — or is not issued at all.
  //
  //   null                       nothing recorded here; plan as before
  //   { sidestepped }            the body was moved a couple of squares first — proceed,
  //                              the planner now starts from a square that has not wedged
  //   { refused, gave_up }       the cap was reached; the caller refuses the journey the
  //                              way the confinement gate does, and the pass falls through
  //                              to what it does when it cannot travel
  //
  // The sidestep rotates through eight directions on `repeats`, so two consecutive
  // attempts never aim the same way, and a step the map refuses simply does not move the
  // body — the next break then counts, and the cap still bounds the whole episode.
  //
  // THE HOLD OUTLIVES THE RECORD. Giving up sets `wedgeHold`, and every `travel()` from
  // that place is refused fast until it expires, without a new note per pass — the
  // decision trail was already 217 identical entries long once, and that was the problem.
  // Moving away, or the hold expiring, drops both so the next episode starts a fresh
  // count: a wedge that was genuinely transient earns another try, and one that was not
  // earns another single line, two minutes later, which is the cadence an operator can
  // read.
  // BACK UP TO WHERE THIS ROOM WAS WORKING, AND WRITE DOWN EXACTLY WHERE IT STOPPED.
  //
  // Animal, the Cragged Mountains, 2026-09-05 14:49. Wedged against the eastern side with no
  // realistic chance of ever getting out — while two other characters crossed the same room in
  // the same minutes without noticing anything. Taken over by hand and walked back the way he
  // came, he then travelled to Castle Victoria perfectly normally. Nothing was wrong with the
  // character, the route or the map. He was standing on a square from which the router could
  // not see a way on, and every remedy we had tried to solve that WITHOUT LEAVING THE SQUARE.
  //
  // That is the pattern behind most of what we call "stuck": the plan is fine two squares
  // back. So the escape is positional, and it is a LADDER, because each rung costs more:
  //
  //   1. breadcrumbs   — undo the last few validated steps. Cheap, local, already existed,
  //                      and it is enough for an ordinary bounce.
  //   2. the entry     — walk back to the square this character ENTERED the room by. Not a
  //                      guess: `enteredVia.landing` is a square observed in THIS room and
  //                      which we know connects to the room next door.
  //   3. the last room — cross back through it, and let the journey re-plan from there.
  //
  // The rung is chosen by how many times we have already had to do this in THIS room, so an
  // ordinary wedge still gets the cheap answer and a genuinely trapped character stops paying
  // for rungs that have already failed. Nothing here relaxes collision: rung 1 replays
  // validated moves backwards, and rungs 2 and 3 walk to a square the character has already
  // occupied, through the validator, like any other walk.
  //
  // THE LEDGER ROW IS HALF THE POINT. Backing up to go forward is a WORKAROUND — every time
  // it fires, the routing could have done better — so each one writes a `stuck_backed_up`
  // event carrying the square, the room, what the character was doing, which tactics had
  // already been tried, where the monsters were standing and which rung actually freed it.
  // `m59-stucks.mjs` reads them back grouped by square, so the recurring ones can be fixed
  // properly and the workaround can stop being needed there. A workaround that is not
  // recorded is a bug that never gets fixed.
  stuckRung(place, { owner = 'movement' } = {}) {
    // How many back-ups this character has already needed in this room lately. Keyed on the
    // ROOM rather than the square: a character that bounces between three bad squares in one
    // room is having one problem, not three, and answering each with rung 1 is how it spends
    // ten minutes there.
    const episode=this.survivalJam();
    const WINDOW_MS = 10 * 60_000;
    const now = Date.now();
    this.backUps = (this.backUps || []).filter(b => now - b.at < WINDOW_MS
      && (!b.jam_id || b.jam_id===episode?.id)
      && (!b.failed || (b.jam_id && b.jam_id===episode?.id) || watchdog.sameWedgePlace(b, place)));
    // Survival must escalate failures, not just successful escapes. Keep those
    // attempts out of the ordinary mover's history so a hurt episode cannot make
    // a later healthy journey skip its cheap first option.
    const here = this.backUps.filter(b => b.room === place?.room
      && (!b.failed || owner === 'survival')).length;
    return Math.min(here + 1, 3);
  }

  /**
   * Walk out of a place the router cannot plan out of, escalating until something moves.
   *
   * Returns the record of what was tried — never throws, and never acts below the flee line,
   * where the survival ladder already owns the body and this would be a second opinion about
   * the same emergency.
   */
  async backUpToUnstick(why, { advice = null, to = null, owner = 'movement' } = {}) {
    const s = this.s, geo = s?.world?.geometry;
    const from = this.wedgePlace();
    const t0 = Date.now();

    // WHOSE DECISION IS THIS? It decides whether the flee line is a wall or not.
    //
    // A MOVEMENT caller must stop at the flee line. Below it the survival ladder owns the
    // body, and a mover that keeps steering down there is what killed Cccc — walked out of a
    // sanctuary at 27% against a 70% threshold and eaten in twenty-two seconds, with the
    // keeper watching every frame.
    //
    // THE SURVIVAL LADDER ITSELF IS A DIFFERENT CALLER. When it asks, this walk is not a
    // second opinion about the emergency — it IS the survival decision, chosen by the thing
    // that owns the body, on its own clock. Refusing it there was the hole: a character
    // wedged AND below the line is the exact 70-of-70 not-swinging death, and it was the one
    // case in which the only remedy that could have worked was switched off. Escaping the
    // thing that is killing you is a survival act; that it happens to be a walk is not a
    // reason to withhold it from the ladder whose job it is.
    if (owner !== 'survival') {
      const frac = pct(s?.client?.vitals?.()?.health);
      if (frac !== null && frac < this.safety().fleeAt)
        return { attempted: false, owner,
                 why: 'below the flee line — the survival ladder owns the body' };
    }

    const episode = owner === 'survival' ? this.survivalJam() : null;
    const pocket = episode ? {room:episode.room,row:episode.row,col:episode.col} : from;
    const rung = this.stuckRung(from, { owner });
    const tried = [];
    // Every fallback belongs to the same command. A cancelled retreat must not
    // acquire a fresh generation and resume over a newer rescue or human command.
    const movementGeneration = s?.movementGeneration;
    const ownerRevision=this._survivalOwnerRevision??0;
    const client = s.client, lifeBoundary = s.lifeBoundary ?? 0, deaths = this.tally?.deaths ?? 0;
    let interrupted = null;
    const interruption = () => {
      if (interrupted) return interrupted;
      if (s.client !== client) return interrupted = 'client replaced';
      if ((s.lifeBoundary ?? 0) !== lifeBoundary || (this.tally?.deaths ?? 0) !== deaths
          || s.world?.room?.num === 1 || client?.vitals?.()?.health?.value <= 0)
        return interrupted = 'death during retreat';
      if (owner === 'survival' && ((this._survivalOwnerRevision??0)!==ownerRevision
          || this.stopping || (this.inert&&!this.inert.travelling)
          || this.facultyHeld('survival') || this.facultyHeld('combat') || this.facultyHeld('recovery')))
        return interrupted = 'survival owner changed';
      return null;
    };
    // A scoped lease cancels the paced mover itself, without cancelling a newer
    // command or the post-death recovery owner. Death persists across respawn.
    const controlToken = Symbol('retreat life and owner lease');
    (s.movementCancellationChecks ??= new Map()).set(controlToken, interruption);
    const cancelled = () => !!interruption() || !!s?.movementWasCancelled?.(movementGeneration, controlToken);
    try {
    const terminalReason = () => tried.find(t => isTerminalMovementReason(t.reason))?.reason;
    const canContinue = () => !cancelled() && !terminalReason() && !this.hold && !this.holdWorks()
      && !this.currentRecoveryWall?.();
    // WHICH RUNG ACTUALLY FREED IT, not which rung ran after one that did.
    //
    // `worked` used to be `moved()`, which compares against the position captured when the
    // ladder was ENTERED — so every rung after a successful one inherited its credit. Seen
    // live on the first wedge after deploy-2026-09-06-8: rung 1.5 walked Bunsen four steps
    // out of the Cragged Mountains and rung 1, finding the trail already spent, recorded
    // `steps: 0, worked: true`. Harmless to the character and fatal to the measurement,
    // which is the whole reason the rungs are numbered separately.
    //
    // `sinceLastRung` compares against where the PREVIOUS rung left the body, so the credit
    // lands where the movement did. Advanced by the caller after each attempt.
    let rungMark = this.wedgePlace();
    const sinceLastRung = () => {
      const at = this.wedgePlace();
      const was = rungMark;
      rungMark = at ?? rungMark;
      return !!at && !!was && (at.room !== was.room || at.col !== was.col || at.row !== was.row);
    };
    const moved = () => {
      const at = this.wedgePlace();
      if (!at || !from) return false;
      return at.room !== from.room || at.col !== from.col || at.row !== from.row;
    };

    const escaped = () => !cancelled() && (owner !== 'survival' ? moved()
      : !!this.currentRecoveryWall?.() || this.holdWorks()
        || (!!this.wedgePlace() && !!pocket && !sameJamPocket(pocket, this.wedgePlace())));

    // ---- rung 1.5: back onto the RAIL, not merely back a few squares.
    //
    // ATTEMPTED BEFORE RUNG 1, AND STILL CALLED 1.5, because it is rung 1's move with a
    // better place to stop: the same validated crumbs, the same 12-crumb budget, replayed
    // through the same validator. Rung 1 unwinds blindly and stops counting; this stops the
    // moment the baked lane is under foot again, which CONTINUES the journey where rung 2
    // restarts it from the door. Same cost, strictly better ending — so it goes first, and
    // rung 1 is what happens when there is no rail to aim at.
    //
    // Ordering it after rung 1 made it dead code, which is worth writing down because it
    // looked right: rung 1 has no `until`, so any crumb it walks sets `moved()` and a
    // `!moved()` guard below it can essentially never open. The only state that reached it
    // was rung 1 moving ZERO crumbs — a broken or empty trail — where this rung replays the
    // same trail through the same validator and fails the same way.
    //
    // Measured 2026-09-05 over 1,238 travel deaths carrying `ms_since_moved`: the median
    // character had not moved for 86 SECONDS when it died, p25 22s. The top three rooms are
    // the Cragged Mountains, the border of the Badlands and Ukgoth — all of them steps on a
    // longer trip, which is exactly where a rail exists to rejoin.
    //
    // `onwardExit` and not `anchorFor(activeRoutes(), from.room, to)`: `to` is the JOURNEY'S
    // DESTINATION, up to 25 hops away, while `anchorFor` answers for an ADJACENT room. Asked
    // the wrong way it resolves only when the wedged room happens to border the destination —
    // the last hop of a trip — and returns null on exactly the long crossings this rung was
    // built for. `onwardExit` takes the first hop of the route, and is memoised because
    // `world.route()` runs the room's exits flood and can block the loop for seconds.
    let railed = false;
    if (canContinue() && to != null && typeof s?.retreatToRail === 'function') {
      // `cachedOnly`, because this is the survival ladder and `onwardExit` can otherwise run
      // the exits flood. Declining is the honest answer: rung 1 is right there.
      const aim = this.onwardExit(from?.room, to, { cachedOnly: true });
      if (aim && Number.isFinite(Number(aim.row)) && Number.isFinite(Number(aim.col))) {
        const out = await s.retreatToRail({ toSquare: { row: aim.row, col: aim.col }, maxCrumbs: 12, movementGeneration, controlToken })
          .catch(e => ({ moved: false, reason: e.message }));
        // REJOINING IS THE POINT; MOVING IS NOT. `near()` is a Chebyshev-2 box around any
        // rail square, so a body three squares off the lane can walk ONE crumb back, open
        // the box, and stop. Counting that as success would gate rung 1's twelve-crumb
        // unwind and rungs 2 and 3 on it — leaving the character one square from the place
        // that wedged it, recorded `freed: true`, having spent a level of `stuckRung`'s
        // budget for the next episode in this room. Moved-but-not-rejoined falls through.
        railed = out?.rejoined === true && escaped();
        tried.push({ rung: 1.5, how: 'back onto the rail', steps: out?.steps ?? 0,
                     rejoined: out?.rejoined === true, rail_squares: out?.rail_squares ?? null,
                     reason: out?.reason ?? null, moved_here: sinceLastRung(), worked: railed });
      }
    }

    // ---- rung 1: undo the last few validated steps. The fallback when there was no rail to
    // aim at, or aiming at it moved nothing.
    if (canContinue() && !railed && typeof s?.retreatAlongBreadcrumbs === 'function') {
      const out = await s.retreatAlongBreadcrumbs({ maxCrumbs: 12, movementGeneration, controlToken })
        .catch(e => ({ moved: false, reason: e.message }));
      tried.push({ rung: 1, how: 'breadcrumbs', steps: out?.steps ?? out?.crumbs ?? 0,
                   reason: out?.reason ?? null, moved_here: sinceLastRung(), worked: escaped() });
    }

    // ---- rung 2: the square we came in by. `enteredVia` is the session's own memory of the
    // crossing, so it is only usable while it still describes the room we are standing in.
    const back = s?.enteredVia;
    const entryIsHere = back && Number(back.room) === Number(from?.room) && back.door;
    const landing = entryIsHere && Number(back.landing?.room) === Number(from?.room)
      && Number.isFinite(back.landing?.row) && Number.isFinite(back.landing?.col)
      ? back.landing : null;
    if (canContinue() && rung >= 2 && !escaped() && entryIsHere && !landing) {
      tried.push({ rung: 2, how: 'the door we came in by', skipped: 'no observed landing in this room' });
    }
    if (canContinue() && rung >= 2 && !escaped() && landing && typeof s?.walkTo === 'function') {
      const d = landing;
      const already = from && d.col === from.col && d.row === from.row;
      if (already) {
        tried.push({ rung: 2, how: 'the door we came in by', skipped: 'already standing on it' });
      } else {
        const w = await s.walkTo(d.col, d.row, { movementGeneration, controlToken }).catch(e => ({ arrived: false, reason: e.message }));
        tried.push({ rung: 2, how: 'the door we came in by', to: `${d.col},${d.row}`,
                     arrived: !!w?.arrived, reason: w?.reason ?? null, worked: escaped() });
      }
    }

    // ---- rung 3: back through it, into the room we came from. The journey re-plans from
    // there, which is the whole objective — not undoing the trip, changing where it starts.
    if (canContinue() && rung >= 3 && !escaped() && entryIsHere && Number.isFinite(Number(back.from)) &&
        typeof s?.travel === 'function') {
      const prev = Number(back.from);
      // ONE HOP, NOT A JOURNEY. The previous room is adjacent by construction — we walked
      // out of it — so a 25-hop budget here would let an escape turn into a world tour, and
      // this runs at the gate BEFORE the real journey is issued. `maxStumbles` is low for the
      // same reason: if the door we came in by will not take us back, that is the finding,
      // and the answer is the hold below rather than grinding on it.
      const t = await s.travel(prev, { origin: keeperOrigin('unstick'), maxHops: 2, maxStumbles: 2, movementGeneration, controlToken })
        .catch(e => ({ arrived: false, reason: e.message }));
      const at = this.wedgePlace();
      tried.push({ rung: 3, how: 'back through the door, into the previous room', room: prev,
                   arrived: !!t?.arrived, reason: t?.reason ?? null,
                   worked: escaped() && Number(at?.room) === prev });
    }

    const at = this.wedgePlace();
    const freed = escaped();
    // A blocked breadcrumb trail otherwise retries rung 1 forever: the old
    // success-only counter never unlocked the entry / previous-room fallbacks.
    // Supersession is not a failed escape and must not advance this history.
    if (!cancelled() && freed) {
      this.backUps = this.backUps.filter(b => !b.failed);
      this.backUps.push({ room: from?.room, col: from?.col, row: from?.row, at: t0 });
    } else if (canContinue() && owner === 'survival' && tried.length && rung < 3) {
      this.backUps.push({ room: from?.room, col: from?.col, row: from?.row,
                          at: t0, failed: true, jam_id:this.survivalJam()?.id });
    }

    // WHAT THE ROOM LOOKED LIKE, so the recurring ones can be diagnosed without being caught
    // live. Positions are relative to where the character was stuck: an absolute list of
    // monster squares is a fact about one afternoon, but "two things two squares east" is the
    // shape of the trap.
    const th = this.threat?.() ?? null;
    const v = s?.client?.vitals?.() ?? null;
    const near = (th?.near || []).slice(0, 8).map(o => ({
      name: s?.client?.rsc?.get?.(o.nameRsc) ?? null,
      d: Math.round(Math.hypot(o.col - (from?.col ?? o.col), o.row - (from?.row ?? o.row))),
      col: o.col, row: o.row,
    }));

    recordEvent(this.who(), 'stuck_backed_up', {
      why, room: from?.room ?? null, room_name: s?.world?.room?.name ?? null,
      square: from ? `${from.col},${from.row}` : null,
      col: from?.col ?? null, row: from?.row ?? null,
      wanted: to,
      // WHAT THE ROUTING HAD ALREADY TRIED, which is the field that says whether this square
      // is a map problem or a tactics problem.
      doing: advice?.doing ?? null,
      repeats: advice?.repeats ?? null,
      wedged_for_ms: advice?.wedged_for_ms ?? null,
      // Is this square one the coarse grid refuses? That single bit separates "the router
      // cannot plan from here" from "the router planned and the walk failed", and they have
      // completely different fixes.
      coarse_walkable: (geo && from && typeof geo.walkable === 'function')
        ? geo.walkable(from.row, from.col) : null,
      entered_via: entryIsHere ? { door: back.door, landing: back.landing ?? null,
                                  from: back.from } : null,
      // WHO ASKED. A back-up done for the mover and one done to get out of a fight that is
      // killing us are the same walk and completely different evidence: `survival` rows are
      // the ones where a character was below the flee line with something in reach, and they
      // are the rows worth reading first.
      owner,
      cancelled: cancelled(), interruption: interruption(), displaced: moved(), pocket, terminal_reason: terminalReason() ?? null,
      rung_allowed: rung, tried, freed,
      ended: at ? { room: at.room, square: `${at.col},${at.row}` } : null,
      monsters: near, monsters_in_room: th?.near?.length ?? null,
      adjacent: th?.adjacent?.length ?? null,
      // NUMBERS, NOT THE VITALS OBJECTS. `vitals()` answers `{ value, max }` per vital, and
      // a row carrying those verbatim reads as `[object Object]` in every report that prints
      // it and sorts wrong in every one that does not.
      health: v?.health?.value ?? null, max_health: v?.health?.max ?? null,
      health_pct: pct(v?.health) === null ? null : Math.round(pct(v.health) * 100),
      vigor: v?.vigor?.value ?? null,
      took_ms: Date.now() - t0,
      note: 'backing up to go forward is a WORKAROUND. Every row here is a place the routing ' +
            'should have handled and did not — read them with m59-stucks.mjs, grouped by ' +
            'square, and fix the ones that repeat',
    });

    return { attempted: true, owner, rung, tried, freed, displaced: moved(), pocket,
             cancelled: cancelled(), interruption: interruption(),
             terminal_reason: terminalReason() ?? null,
             from: from ? `${from.col},${from.row}` : null,
             ended: at ? { room: at.room, col: at.col, row: at.row } : null };
    } finally { s.movementCancellationChecks.delete(controlToken); }
  }

  // THE WEDGE LADDER'S BLINK RUNG. Gated, never forced: off by policy, fighting (survival and the fight own the body),
  // under WEDGE_BLINK_MIN_HEALTH, short of mana, or no blink known all fall through to the sidestep. blinkFree does the
  // cast and judges it by position, never by the cast reply.
  async wedgeBlink(advice) {
    if (this.policy?.blinkWhenWedged === false) return { moved: false, why: 'blink_when_wedged is off' };
    if (this.s?.combat?.active) return { moved: false, why: 'in combat' };
    const c = this.s?.client, v = c?.vitals?.();
    const hp = v?.health?.max ? v.health.value / v.health.max : null;
    if (hp !== null && hp < WEDGE_BLINK_MIN_HEALTH) return { moved: false, why: `health ${Math.round(hp * 100)}%` };
    if ((v?.mana?.value ?? 0) < BLINK_MANA) return { moved: false, why: 'short of mana' };
    // NOT AT A DOOR. A door is slow, not jammed: the 382/376 door can hold a body on one square for 100-120s and then
    // let it through (Piggy, 2026-10-22, 350 c28 r51 beside the 382 door at c27 r52). A blink there lands on the room's
    // fixed point, usually across the room, and the body has to come back to the same door. Blink cannot fix a door.
    const door = this.doorNear(advice.room, advice.col, advice.row, WEDGE_BLINK_DOOR_SQUARES);
    if (door) return { moved: false, why: `beside the door to ${door.to} at ${door.col},${door.row}` };
    if (!(c?.spells || []).some(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'blink'))
      return { moved: false, why: 'does not know blink' };
    this.wantsBlink = { why: `wedged ${Math.round((advice.wedged_for_ms ?? 0) / 1000)}s at ${advice.col},${advice.row} ` +
                              `in room ${advice.room} (watchdog record ${advice.repeats})`, at: Date.now() };
    return (await this.blinkFree({ cooldownMs: WEDGE_BLINK_COOLDOWN_MS })) ?? { moved: false, why: 'blink cooldown' };
  }

  // The nearest unlocked door (a go-exit square of the movement map) within `within` squares, or null. Unknown map or
  // room is null too: the guard then does not stop a blink, which keeps the rung working where geometry is unread.
  doorNear(room, col, row, within = 2) {
    const R = this.s?.world?.map?.rooms;
    const r = Array.isArray(R) ? R.find(x => Number(x?.num) === Number(room)) : (R?.[room] ?? R?.[String(room)]);
    if (!r || col == null || row == null) return null;
    return (r.goExits ?? []).find(e => !e.locked && Math.abs(e.col - col) <= within && Math.abs(e.row - row) <= within) ?? null;
  }

  async answerWedge(to = null) {
    const now = Date.now();
    const w = this.watch;
    const hold = this.wedgeHold;
    if (hold) {
      const here = this.wedgePlace();
      if (here && watchdog.sameWedgePlace(hold, here) && now < hold.until) {
        this.progress('wedged here — holding in place rather than re-issuing the walk');
        return { refused: true, gave_up: true, held_for_ms: hold.until - now,
                 why: `gave up walking from ${hold.col},${hold.row} in room ${hold.room} ` +
                      `${Math.round((now - hold.at) / 1000)}s ago — ${hold.repeats} walks from it went ` +
                      `nowhere; holding for ${Math.round((hold.until - now) / 1000)}s more` };
      }
      this.wedgeHold = null;
      if (w) w.wedgeBreak = null;
    }
    const advice = this.wedgeHere(now);
    if (!advice) return null;
    const square = `${advice.col},${advice.row}`;
    if (advice.verdict === 'give_up') {
      // GIVING UP MUST NOT MEAN STANDING THERE.
      //
      // The hold below exists for a good reason — "cancelling changes nothing when the
      // inputs do not" — and for a long time its answer to that was to stop issuing walks
      // and let the character wait two minutes where it was. On a hunting floor that is
      // fine. On the road it is the whole death: measured over 24 hours, 70 of 70 deaths
      // were characters NOT SWINGING and most were not moving either, wedged in the
      // Cragged Mountains corridor with trolls and black spiders arriving, and the hold is
      // 120 seconds. The postmortems read "travelling, moving:false" for a median of a
      // minute; this is where that minute comes from.
      //
      // And standing still does not change the inputs either. RETREATING DOES. Backing out
      // along the trail puts the next attempt on a different square in a different part of
      // the room, which is the thing the hold was trying to achieve and could not.
      //
      // Every step of the retreat is a move the fine validator already accepted on the way
      // in, replayed backwards, so this cannot invent a traversal a wedged character could
      // not make — the same argument that lets a breadcrumb retreat work at all.
      //
      // NOT BELOW THE FLEE LINE. Down there the survival ladder owns the body and is
      // already running; a wedge-retreat would be a second opinion about the same emergency.
      // AND THE RETREAT ESCALATES. Twelve breadcrumbs is the right answer to an ordinary
      // bounce and no answer at all to a character standing somewhere the router cannot plan
      // out of — Animal spent his afternoon in the Cragged Mountains proving that, while two
      // fleet-mates crossed the same room without noticing. `backUpToUnstick` climbs from the
      // breadcrumbs to the square this character came in by, and then back through the door
      // into the previous room, depending on how many times this room has already needed it.
      // ONE CHARACTER'S UNSTICK TACTIC IS A POLICY, NOT A BUILD FLAG.
      //
      // `escape_ladder: false` leaves this character to the hold below and nothing else, so
      // a fleet can be split down the middle and both halves run at the same hour, in the
      // same rooms, against the same spawns. That is the only way to ask "is the ladder
      // worth its cost" without comparing two different days.
      //
      // Deliberately per character rather than per process. The arrangement it replaces was
      // two brokers with different environments, which needs two keeper bands, two ports and
      // twice the machine — and still cannot rule out that one arm simply had a worse hour.
      //
      // `back_up_when_wedged` is NOT this switch and never was: it gates
      // escapeIfWedgedAndHurt, the survival rung below the flee line. This gates the ladder
      // a HEALTHY wedged character reaches, which is the larger population and the one the
      // record/cancel split restored.
      const ladderOff = this.policy?.escapeLadder === false;
      let backedOff = ladderOff
        ? { moved: false, skipped: 'escape_ladder is off for this character' } : null;
      if (!ladderOff) try {
        const out = await this.backUpToUnstick('a wedge the watchdog gave up on',
                                               { advice, to });
        const after = this.wedgePlace();
        const moved = !!after && (after.room !== advice.room ||
                                  after.col !== advice.col || after.row !== advice.row);
        backedOff = { moved, rung: out?.rung ?? null, tried: out?.tried ?? null,
                      to: after ? `${after.col},${after.row}` : null,
                      room: after?.room ?? null,
                      why: out?.attempted === false ? out.why : null };
        // AND PUT A WALL AT ITS BACK WHILE IT WAITS. A retreat that ends in open ground
        // has traded one bad square for another; the wall is what makes the wait cheap.
        // Not after a rung-3 retreat: that one deliberately ended in a different room, and
        // pinning it to a wall there would fight the journey that is about to re-plan.
        if (moved && after?.room === advice.room && typeof this.takeSafeSpot === 'function')
          await this.takeSafeSpot('waiting out a wedge give-up behind a wall', null,
                                  { source: 'wedge' }).catch(() => null);
      } catch { /* the retreat is the improvement, never the requirement */ }

      // THE HOLD IS ANCHORED WHERE IT ENDED UP, not where it wedged. That is the whole
      // point of moving: `sameWedgePlace` then reads false at the new square, so the next
      // travel is planned rather than refused, from ground that has not already failed.
      const at = this.wedgePlace() ?? { room: advice.room, col: advice.col, row: advice.row };
      this.wedgeHold = { room: at.room, col: at.col, row: at.row,
                         repeats: advice.repeats, to, at: now,
                         backed_off: !!backedOff?.moved,
                         until: now + watchdog.WEDGE_GIVEUP_HOLD_MS };
      this.tally.wedge_giveups = (this.tally.wedge_giveups || 0) + 1;
      this.note('WATCHDOG — gave up: ' + advice.repeats + ' walks from the same square went nowhere', {
        room: advice.room, square, wanted: to, doing: advice.doing,
        wedged_for_s: Math.round(advice.wedged_for_ms / 1000),
        hold_s: Math.round(watchdog.WEDGE_GIVEUP_HOLD_MS / 1000),
        why: 'the watchdog broke a wedge here ' + advice.repeats + ' times and every pass ' +
             're-issued the same walk from the same square. Cancelling changes nothing when ' +
             'the inputs do not, so this converts an unbounded loop into a bounded one: no ' +
             'walk is issued from this place until the hold expires, and the pass falls ' +
             'through to whatever it does when it cannot travel',
        backed_off: backedOff ?? 'not attempted — below the flee line, or no trail to walk back',
        note: 'the objective is not thrown away — the hold expires and the next attempt ' +
              'starts a fresh count, now from wherever the retreat ended rather than from ' +
              'the square that failed. If this line repeats at the same square, the square ' +
              'is the problem: record it with m59-recordjam.mjs',
      });
      // ONE ROW PER GIVE-UP, IN BOTH ARMS. This event already existed and already fired
      // whether or not anything was climbed, which makes it the denominator the escape
      // ladder can be priced against: of the characters that wedged, what happened next,
      // with the ladder and without it.
      //
      // A duplicate emitter was briefly added at the top of this branch to do exactly this,
      // because the search that preceded it looked for `stuck_backed_up` and never asked
      // whether a give-up event already existed. It did. Every wedge then wrote two rows —
      // one carrying the arm and one not — and an analysis that read a missing
      // `escape_ladder` as false counted every ladder-arm wedge in BOTH arms. That is where
      // "the ladder arm re-wedges 100% of the time" came from: it was the same event,
      // counted twice, three seconds apart.
      //
      // `escape_ladder` is stamped on the ROW rather than joined from the roster afterwards,
      // because a roster is edited between runs and a row is not.
      recordEvent(this.who(), 'wedge_gave_up', {
        room: advice.room, room_name: this.s?.world?.room?.name ?? null,
        col: advice.col, row: advice.row, to, repeats: advice.repeats,
        wedged_for_ms: advice.wedged_for_ms,
        escape_ladder: !ladderOff,
        climbed: backedOff?.moved === true,
        rung: backedOff?.rung ?? null,
        health: this.s?.client?.vitals?.()?.health?.value ?? null,
        max_health: this.s?.client?.vitals?.()?.health?.max ?? null,
      });
      this.recordFrame('gave up a wedge');
      return { refused: true, gave_up: true, repeats: advice.repeats,
               why: `${advice.repeats} walks from ${square} in room ${advice.room} went nowhere` };
    }
    // vary: start the next plan from a different square.
    const from = this.wedgePlace();
    if (!from) return null;
    // FIRST, BLINK (see WEDGE_BLINK_COOLDOWN_MS). Blink lands on the room's fixed teleport point, which in a town is open
    // floor reachable from the rest of the room -- a better new start than two squares beside the jam.
    const blinked = await this.wedgeBlink(advice).catch(e => ({ moved: false, why: e.message }));
    if(blinked?.cancelled)return {cancelled:true};
    if (blinked?.moved) {
      if (w) w.wedgeBreak = null;   // a new square; the next walk is planned from it, not counted against the old one
      this.tally.wedge_blinks = (this.tally.wedge_blinks || 0) + 1;
      recordEvent(this.who(), 'wedge_blinked', { room: advice.room, col: advice.col, row: advice.row, to,
        repeats: advice.repeats, wedged_for_ms: advice.wedged_for_ms, landed: blinked.to ?? null });
      return { blinked: true, moved: true, to: blinked.to ?? null };
    }
    const d = WEDGE_SIDESTEPS[(advice.repeats - 1) % WEDGE_SIDESTEPS.length];
    const aim = { col: from.col + d.dc, row: from.row + d.dr };
    let out;
    try { out = await this.s.walkTo(aim.col, aim.row, { maxSteps: 6 }); }
    catch (e) { out = { arrived: false, reason: e.message }; }
    const after = this.wedgePlace();
    const moved = !!after && (after.room !== from.room || after.col !== from.col || after.row !== from.row);
    this.tally.wedge_sidesteps = (this.tally.wedge_sidesteps || 0) + 1;
    this.note('wedge — sidestepping before re-planning', {
      repeats: advice.repeats, cap: advice.cap, direction: d.name,
      from: `${from.col},${from.row}`, aimed: `${aim.col},${aim.row}`,
      now: after ? `${after.col},${after.row}` : null, moved,
      arrived: out?.arrived ?? null, reason: out?.reason ?? out?.why ?? null,
      wanted: to,
      why: 'the watchdog broke a wedge here and the next walk would start from the same ' +
           'square with the same destination. The one input the planner cannot get from ' +
           'the map is where it starts, so change that first',
    });
    return { sidestepped: true, moved, direction: d.name };
  }

  // THERE ARE TWO DEFENSIVE MANOEUVRES IN A FIGHT AND THERE IS NO THIRD.
  //
  // Operator's doctrine, 2026-09-06:
  //
  //   1. NOT on a safe wall  ->  go to the nearest one.
  //   2. ON a safe wall      ->  log off and back on, turn, and rest.
  //
  // Nothing else may interrupt a fight. Not a town trip, not a breadcrumb retreat, not a
  // wander to "somewhere I can heal" — those are the movement-shaped rungs that a
  // post-mortem records as "every decision correct, 0.0 squares per second, dead".
  //
  // WHY THE SECOND ONE IS A MANOEUVRE AND NOT A TRICK. A safe wall is a square nothing can
  // reach, and that is the ONLY place the logoff works: log off so the monster disengages
  // and you do not die, come back, turn so the server registers the move, and rest to full
  // while the room mills about outside its reach. `playDead` already implements exactly
  // that — logoff, reconnect, reclaim the square, turn — so this rung chooses it rather
  // than reimplementing it. It is also the reason the two manoeuvres are ONE law rather
  // than two: what makes a square worth fleeing to is the same property that makes the
  // logoff work there, which is why the safe-wall ledger collapsed into geometry.
  //
  // GATED ON HAVING BEEN IN A FIGHT. This narrows the survival ladder, and narrowing it
  // for a character that is merely hurt while walking would take away rungs that are
  // right there — travel has its own guard, and a character bleeding in a corridor is not
  // having a fight. `engagedRecently` is the gate.
  async defensiveAnswer({ near = [], v = null } = {}) {
    if (this.policy?.defensiveAnswer === false) return false;
    if (!near.length) return false;                 // nothing is hitting us: not this rung
    const frac = pct(v?.health);
    if (frac === null || frac >= this.safety().fleeAt) return false;
    // Only inside a fight. `doing` is what the pass last set, and a fight that broke off at
    // the flee line leaves it on `fighting` until something else claims it.
    if (this.doing !== 'fighting' && !this.hold) return false;

    // ---- 2. ON a wall: log off, come back, turn, rest.
    if (this.hold && this.holdWorks()) {
      const did = await this.playDead(
        `at ${v?.health?.value ?? '?'} health on a safe wall — the logoff is the manoeuvre here`)
        .catch(() => false);
      if (did) {
        this.note('defensive answer: the logoff at a wall', {
          health: v?.health ? `${v.health.value}/${v.health.max}` : null,
          in_reach: near.length, spot: { col: this.hold.col, row: this.hold.row },
          why: 'nothing can reach this square, so logging off breaks the engagement without ' +
               'losing the ground. Coming back, turning and resting is a free heal to full — ' +
               'and it is the only defensive move that does not give up the wall',
        });
        return true;
      }
      // playDead refused (already turned since reclaiming, or no proven wall). Falling
      // through is correct: the rest rung below is what it defers to, and resting ON the
      // wall is still manoeuvre 2 minus the reconnect.
      return false;
    }

    // ---- 1. NOT on a wall: go to the nearest one. Nowhere else.
    if (typeof this.takeSafeSpot !== 'function') return false;
    const took = await this.takeRecoverySpot(
      `at ${v?.health?.value ?? '?'} health with ${near.length} in reach — the nearest wall is ` +
      'the only place to be', { source: 'defensive' }).catch(() => null);
    if (took?.took) {
      this.note('defensive answer: to the nearest safe wall', {
        health: v?.health ? `${v.health.value}/${v.health.max}` : null,
        in_reach: near.length,
        why: 'the one defensive move available off a wall. A town trip, a breadcrumb ' +
             'retreat or a wander to "somewhere I can heal" are all movement-shaped rungs ' +
             'that read correct in a post-mortem and end at 0.0 squares per second',
      });
      return true;
    }
    // No wall reachable. Say so once and let the ladder below have it — refusing to fall
    // through would idle a character that has nowhere to go, which is the failure this
    // whole file keeps paying for.
    this.note('defensive answer: no wall to reach', {
      health: v?.health ? `${v.health.value}/${v.health.max}` : null,
      in_reach: near.length, why: took?.why ?? 'takeSafeSpot found nothing',
      note: 'falling through to the ordinary ladder because there is no second option here',
    });
    return false;
  }

  // WEDGED, HURT, AND SOMETHING IN REACH: GET OUT FIRST. TRADE ONLY IF YOU CANNOT.
  //
  // `tradeInPlaceIfWedged` below is right about its premise and was wrong about one word.
  // Its argument is "every rung from here is movement-shaped and the body has not moved, so
  // a swing is the only rung left that changes anything" — and the body not moving was TRUE
  // of every rung the ladder had, because every one of them tries to go SOMEWHERE NEW. Going
  // somewhere OLD is a different question, and nothing was asking it.
  //
  // Backing out along the way we came is the one form of distance available to a body that
  // cannot advance: every step of it is a move the fine validator already accepted, replayed
  // backwards, so it cannot fail for the reason the forward walk is failing. And distance is
  // what the whole ladder below is reaching for.
  //
  // SO IT IS OFFERED TO THE SURVIVAL LADDER RATHER THAN TAKING THE BODY FROM IT. This runs
  // as a rung of `passFleeAndRest`, on survival's own clock, chosen by survival — the four
  // protected faculties exist so an unattended character still runs from a fight it is
  // losing, and this makes that promise keepable in the one case where it was not. A wedged
  // character below the flee line was the 70-of-70 not-swinging death: the ladder correctly
  // rejected freeze, rest and every town trip, then traded blows with something that was
  // beating it, because the option that would have worked was withheld from it.
  //
  // If it moves the body, the pass ends and the NEXT one runs the whole ladder again from a
  // square that is not a trap — flee, rest behind a wall, town trip, all of them available
  // again. If it does not move, nothing is lost and the trade below happens exactly as
  // before. `back_up_when_wedged: false` switches it off per character.
  async escapeIfWedgedAndHurt({ near = [], v = null } = {}) {
    if (this.policy?.backUpWhenWedged === false) return false;
    // The same gates the trade uses, and for the same reasons: above the flee line the
    // ordinary rungs are right, and behind a working wall resting is. Deliberately NOT
    // gated on `crowded()` — the trade refuses in a crowd because swinging in one is
    // hopeless, but backing out the way we came is the crowd answer, not a casualty of it.
    if (!near.length || this.hold || this.holdWorks()) return false;
    const frac = pct(v?.health);
    if (frac === null || frac >= this.safety().fleeAt) return false;
    const wedge = this.wedgedInPlace();
    if (!wedge) return false;

    const out = await this.backUpToUnstick('wedged and hurt with something in reach',
                                           { owner: 'survival' }).catch(() => null);
    this.blockerEvent('retreat',{source:'survival_ladder',rung:out?.rung??null,
      freed:!!out?.freed,cancelled:!!out?.cancelled,targets:near.map(o=>o.id)});
    if (out?.cancelled) return true; // a newer owner gets the pass; do not trade over it
    if (!out?.freed) return false;

    this.tally.wedge_escapes = (this.tally.wedge_escapes || 0) + 1;
    this.note('wedged and hurt — backed out the way we came instead of trading blows', {
      rung: out.rung, from: out.from, ended: out.ended, in_reach: near.length,
      health: v?.health ? `${v.health.value}/${v.health.max}` : null,
      flee_at: Math.round(this.safety().fleeAt * 100) + '%',
      wedged: wedge.why, wedged_for_s: Math.round(wedge.for_ms / 1000),
      why: 'every other rung from here tries to reach somewhere NEW, which is the thing that ' +
           'is failing. The way we came in is validated ground by construction, so it is the ' +
           'one direction that cannot fail for the reason the forward walk is failing',
    });
    this.progress('backed out of a wedge while hurt');
    return true;
  }

  // WEDGED, HURT, AND SOMETHING IN REACH: TRADE IN PLACE. Asked by the ladder ahead of
  // every movement-shaped rung. The post-mortem this answers had the ladder rejecting
  // freeze and rest each for its own correct reason — "a freeze recovers no health" — and
  // then choosing "moving to somewhere I can heal" eighteen minutes running from a square
  // the body never left, at 3 of 22 with a mace and a centipede adjacent. Every rung it
  // had was movement-shaped, and movement was the thing that was not happening. A swing
  // at what is hitting us is the only rung that changes anything from here, and it is
  // strictly better than standing still being hit.
  //
  // Available before low health as well: do not wait for a routine jam to become
  // lethal. `trade_in_place_when_wedged: false` switches it off per character.
  // A measured jam grants defensive combat, never a general hunting order.
  // Keep one exact body until it dies/leaves reach; reassess survival every swing.
  observeBlockerLure() {
    const p=this.pendingBlockerLure,s=this.s,c=s.client;
    if(!p)return;
    if(c!==p.client || s.movementGeneration!==p.generation || s.world?.room?.num!==p.room
        || Date.now()>p.until || this.stopping
        || (this.inert&&!this.inert.travelling) || this.facultyHeld('survival')
        || this.facultyHeld('combat') || this.facultyHeld('recovery')
        || (c.vitals()?.health?.value??0)<=0) {this.pendingBlockerLure=null;return;}
    const body=c.room.objects.get(p.target_id);
    if(!body || (body.name??c.rsc?.get?.(body.nameRsc))!==p.target)return;
    const displaced=Math.hypot(body.col-p.blocked.col,body.row-p.blocked.row)>=4;
    const arrived=Math.hypot(body.col-p.refuge.col,body.row-p.refuge.row)<=REACH+1;
    if(displaced && arrived) {
      this.pendingBlockerLure=null;
      this.blockerEvent('chase',{operation_id:p.operation_id,target:p.target,target_id:p.target_id,
        observed:true,target_position:{row:body.row,col:body.col},refuge:p.refuge,
        evidence:'same retaliating object observed beside refuge, outside original pocket'});
      this.finishClearedBlocker(p.blocked,{operation_id:p.operation_id,target:p.target,target_id:p.target_id,mode:'lure'});
    }
  }

  blockerEvent(phase,detail={}) {
    this.ledgerEvent('blocker_event',{phase,room_num:this.s.world?.room?.num,
      episode_id:this.survivalJamEpisode?.id??null,...detail});
  }

  blockerPathClear(origin) {
    const s=this.s,c=s.client;
    try {
      return recoveryRefugeReach(s.world?.geometry,c?.self,c?.room?.objects,c?.selfId,
        c?.playersOnline)(origin.col,origin.row)?.reachable===true;
    } catch {return false;}
  }

  finishClearedBlocker(origin,detail) {
    const clear=this.blockerPathClear(origin),v=this.s.client?.vitals?.();
    this.blockerEvent('clearance',{...detail,path_clear:clear,
      scope:'body-aware path to original blocker square; full journey not yet proved'});
    if(clear && pct(v?.health)>=1 && (vigorOf(v)??0)>=80) {
      const d=currentSurvivalDecision(this.s);
      if(d?.status==='pending')finishSurvivalDecision(this.s,d.id,'blocker_cleared','local path clear and fully recovered');
      this.wantsForwardShelter=null;
      this.clearSurvivalJam('local path cleared while recovered');
    }
    return clear;
  }

  async tradeInPlaceIfWedged({ near = [], v = null } = {}) {
    const s=this.s,c=s.client,me=c?.self;
    // A body we will not swing at is asked about first, and only when it is ALL that is in reach.
    if (await this.lureSparedBlocker({near,v}).catch(()=>false)) return true;
    if (this.policy?.tradeInPlaceWhenWedged===false || !me || this.hold || this.holdWorks()
        || !this.armedForSure() || !this.wedgedInPlace()) return false;
    if (this.crowded({forFighting:true}) && this.policy?.tradeInPlaceWhenCrowded===false) {
      this.noteCrowdRefusal('clearing a blocker');return false;
    }
    const nameOf=o=>o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
    // Spawn identity must be exact; an unknown name containing "ant" is not an ant.
    const known=Object.values(loadSpawns(SPAWN_FILE)?.creatures ?? {});
    const infoOf=o=>known.find(x=>String(x.name).toLowerCase()===nameOf(o).toLowerCase());
    const candidates=near.filter(o=>(o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER)
      && infoOf(o)?.level!=null && !this.karmaForbids(nameOf(o)) && !this.sparedHere(o)
      && Math.hypot(o.col-me.col,o.row-me.row)<=REACH);
    const hp=(v ?? c.vitals())?.health,frac=pct(hp);
    if (frac==null || !(hp?.max>0)) return false;
    const weak=o=>infoOf(o).level<hp.max && !this.refuseEngagement(nameOf(o));
    candidates.sort((a,b)=>Number(weak(b))-Number(weak(a))
      || Math.hypot(a.col-me.col,a.row-me.row)-Math.hypot(b.col-me.col,b.row-me.row));
    const target=candidates[0];
    if (!target) return false;
    const strong=!weak(target), name=nameOf(target), room=s.world?.room?.num;
    const origin={row:me.row,col:me.col};
    const blockedSquare={row:target.row,col:target.col};
    const operation_id=process.pid+'-'+Date.now()+'-'+(this._blockerSequence=(this._blockerSequence??0)+1);
    const event=(phase,detail={})=>this.blockerEvent(phase,{operation_id,target:name,target_id:target.id,
      mode:strong?'lure':'weak_fight',...detail});
    const ownerRevision=this._survivalOwnerRevision??0;
    const cancelled=()=>this.stopping || (this._survivalOwnerRevision??0)!==ownerRevision || s.client!==c || s.world?.room?.num!==room
      || (this.inert && !this.inert.travelling)
      || this.facultyHeld('survival') || this.facultyHeld('combat') || this.facultyHeld('recovery')
      || this.checkFreeze() || this.currentRecoveryWall()
      || s.movementWasCancelled?.(generation);
    const generation=s.movementGeneration;
    if (cancelled()) return false;
    let retreat=null;
    if (strong) {
      // Never provoke a larger body without an escape already proved. Prose is
      // name-only, so do not infer selected-target aggro among identical names.
      const namesakes=[...c.room.objects.values()]
        .filter(o=>nameOf(o).toLowerCase()===name.toLowerCase());
      const lowHealth=frac<this.safety().fleeAt, ambiguous=namesakes.length!==1;
      if (lowHealth || ambiguous) {
        event('refusal',{reason:lowHealth?'below flee line':'ambiguous retaliation identity',
          low_health:lowHealth,ambiguous_retaliation:ambiguous,health:hp.value,max_health:hp.max,
          flee_at:this.safety().fleeAt,namesakes:namesakes.map(o=>({id:o.id,row:o.row,col:o.col,
            distance:Math.hypot(o.col-me.col,o.row-me.row)}))});return false;
      }
      retreat=this.planBlockerLure(target,origin);
      if (!retreat) {
        event('refusal',{reason:'no reachable refuge outside the needle'});
        this.note('blocker lure refused without a reachable refuge outside the needle',{target:name,target_id:target.id});
        return false;
      }
    }
    event('start',{origin,blocked_square:blockedSquare,refuge:retreat?.spot??null});
    this.tally.wedge_trades=(this.tally.wedge_trades||0)+1;
    this.note('starting sustained blocker combat',{target:name,target_id:target.id,
      mode:strong?'provoke then lure':'fight until clear',origin,refuge:retreat?.spot ?? null,
      crowd_overridden:!!this.crowded({forFighting:true}),threats_here:this.threatCountHere()});
    const started=Date.now();
    let swings=0,misses=0;
    const retreatNow=async(reason)=>{
      if (cancelled()) {event('cancelled',{reason});return {cancelled:true};}
      const result=retreat
        ? await this.takeSafeSpot(reason,null,{source:'recovery',recovery:true,nearestOnly:true,
            candidateFilter:retreat.filter})
        : await this.takeRecoverySpot(reason);
      event('retreat',{reason,took:!!result?.took,cancelled:!!result?.cancelled,swings,
        refuge:result?.spot??retreat?.spot??null});
      if(strong && result?.took) {
        const body=c.room.objects.get(target.id);
        const chased=!!body && nameOf(body)===name &&
          Math.hypot(body.col-blockedSquare.col,body.row-blockedSquare.row)>=4
          && Math.hypot(body.col-retreat.spot.col,body.row-retreat.spot.row)<=REACH+1;
        event('refuge_arrival',{observed:!!this.currentRecoveryWall(),target_visible:!!body,
          chase_observed:chased,target_position:body?{row:body.row,col:body.col}:null});
        this.pendingBlockerLure={operation_id,client:c,generation:s.movementGeneration,room,
          target:name,target_id:target.id,blocked:blockedSquare,refuge:retreat.spot,until:Date.now()+30000};
        this.observeBlockerLure();
      }
      this.note('blocker combat retreat',{target:name,target_id:target.id,
        reason,took:!!result?.took,cancelled:!!result?.cancelled,swings});
      return result;
    };
    while (!cancelled()) {
      const live=c.room.objects.get(target.id),at=c.self,health=c.vitals()?.health;
      if (!live || !(live.flags & OF.ATTACKABLE) || (live.flags & OF.PLAYER)
          || nameOf(live)!==name || !at
          || Math.hypot(live.col-at.col,live.row-at.row)>REACH) {
        event('target_left',{visible:!!live});
        this.finishClearedBlocker(blockedSquare,{operation_id,target:name,target_id:target.id});break;
      }
      const fraction=pct(health),fleeAt=this.safety().fleeAt;
      if (fraction==null || fraction<=0) break;
      let lastResort=false;
      if (fraction<fleeAt) {
        const r=await retreatNow('blocker combat reached the flee line');
        if (r?.took || r?.cancelled || cancelled() || strong) return true;
        // If every reachable refuge is refused while pinned, a weak body can be
        // the only escape. One defensive swing, then retry the ladder next pass.
        lastResort=true;
      }
      if (strong) {
        if ([...c.room.objects.values()].filter(o=>nameOf(o).toLowerCase()===name.toLowerCase()).length!==1) {
          event('refusal',{reason:'retaliation identity became ambiguous',swings});
          await retreatNow('retaliation identity became ambiguous');return true;
        }
        // Bodies/claims can change during the fight. Revalidate before each
        // provocation, then claim and revalidate once more during the actual walk.
        retreat=this.planBlockerLure(live,origin);
        if (!retreat) { await retreatNow('lure escape became unavailable');return true; }
      }
      this.doing=strong?'provoking a blocker for retreat':'clearing a monster blocker';
      const f=await this.fightNow({target:name,exactTargetId:target.id,rounds:1,
        disengageAt:lastResort?0:fleeAt,loot:false,holdPosition:true,reach:REACH,
        weaponPriority:this.weaponPriorityNow(),bannedWeapons:this.bannedWeaponsNow()});
      swings++;
      if (f?.cancelled || f?.died || cancelled()) {event('cancelled',{died:!!f?.died,swings});return true;}
      if (f?.killed) {
        const receipt=recordBlockerClearance(this.who(),{target:name,target_id:target.id,room_num:room,
          room_object_id:c.room?.id,server:[s.credentials?.host,s.credentials?.port],
          rounds:swings,travel_blocker:true});
        this.tally.blocker_clearances=(this.tally.blocker_clearances||0)+(receipt.duplicate===false?1:0);
        event('target_disappeared',{swings,...receipt,kill_credit:'unattributed'});
        this.finishClearedBlocker(blockedSquare,{target:name,target_id:target.id,clearance_id:receipt.id,operation_id});
        this.progress('travel blocker disappeared');
        return true;
      }
      if (strong && blockerRetaliated(f?.combat ?? [],name,
          [...c.room.objects.values()].map(nameOf))) {
        event('retaliation',{swings,evidence:'unique-name enemy swing',refuge:retreat.spot});
        this.note('blocker retaliated; drawing it away from the needle',
          {target:name,target_id:target.id,swings,refuge:retreat.spot,evidence:'unique-name enemy swing'});
        await retreatNow('blocker retaliated; retreat behind the jam');
        return true;
      }
      if (pct(c.vitals()?.health)<fleeAt && !lastResort) {
        await retreatNow('blocker combat reached the flee line');return true;
      }
      if (lastResort || !f?.fought || f?.out_of_reach || f?.weapon_loss) return true;
      misses=f.landed_hits>0?0:misses+1;
      // No arbitrary three-swing end to a productive weak fight. Bound only a
      // nonproductive fight / unconfirmed lure so an immune body cannot own us.
      if (misses>=20 || (strong && Date.now()-started>=30000)) {
        await retreatNow(strong?'lure retaliation not observed':'blocker fight made no progress');
        return true;
      }
    }
    if(cancelled())event('cancelled',{swings});
    return swings>0;
  }

  planBlockerLure(target,origin) {
    const s=this.s,geo=s.world?.geometry,room=s.world?.room,me=s.client?.self;
    if (!geo || !room || !me) return null;
    const quarryReach=coarseCombatReachFrom(geo,target);
    const outside=lureRefugeFilter(geo,origin,target,quarryReach);
    const spot=this.searchSafeSpot(geo,me,room,{within:Math.max(geo.rows,geo.cols)||64,
      quarryReach,strictQuarryReach:true,los:this.policy.los??0,
      exclusiveClaim:true,shareCap:1,recovery:true,candidateFilter:outside});
    if (!spot) return null;
    return {spot:{row:spot.row,col:spot.col},
      filter:(col,row)=>col===spot.col && row===spot.row && outside(col,row)};
  }

  /** Is this room object a monster this character leaves alive (policy.spareCreatures)? */
  sparedHere(o) {
    const patterns=this.policy?.spareCreatures;
    return !!patterns?.length && isSpared(this.s?.client,o,patterns);
  }

  // A SPARED CREATURE IS THE THING IN THE WAY: DRAW IT OUT, NEVER KILL IT.
  //
  // Operator, 2026-10-11: Qor casters must "walk the barloque sewers without fighting/killing its rats,
  // even if they get stuck (they might need some special tricks to get by the rats without killing
  // them.. maybe sometimes you have to hit them once and then back up so they'll chase you to stop
  // blocking you, etc.)". A rat is karma -20 (giarat.kod), so each kill walks a Qor's karma toward good,
  // and a rat in a one-square pipe is a wall (tools/fixtures/sewers-108-row27.json: six of them, seventy
  // seconds, nobody past).
  //
  // Before this, the wedge ladder's trade (`tradeInPlaceIfWedged`) and `passFightBack` both PICKED the
  // spared body and then had the swing refused by the spare filter: a wasted pass, every pass, and a
  // fightable creature behind it never chosen. Both now skip spared bodies; this is what happens when a
  // spared body is ALL that is in reach.
  //
  // It is the trade's lure without the trade: the same refuge search (`planBlockerLure`: a safe wall
  // outside the needle, behind us, with a 2x2 landing beside it for the chaser), the same retreat, the
  // same chase observation (`pendingBlockerLure` -> `observeBlockerLure` -> `finishClearedBlocker`).
  // What it drops is the ambiguity refusal, because nothing here infers WHO retaliated from prose -- the
  // chase is judged by the target's object id, which is unambiguous among twenty namesake rats.
  //
  //   spare_blockers: 'lure'     back off to the refuge; aggressive creatures (rats, lupoggs) follow
  //   spare_blockers: 'provoke'  first ONE swing at it, only when nothing is already hitting us -- one
  //                              swing from a level-70 does not kill a 30-hp rat as a rule, and a kill
  //                              that does happen is recorded loudly rather than hidden
  //
  // Above the flee line only: below it the body belongs to the survival ladder, which walks away from
  // what it will not fight. Bounded per room so a creature that will not follow cannot own the keeper.
  async lureSparedBlocker({ near = [], v = null } = {}) {
    const mode=this.policy?.spareBlockers;
    if (mode!=='lure' && mode!=='provoke') return false;
    const s=this.s,c=s.client,me=c?.self;
    if (!me || !this.policy?.spareCreatures?.length || this.hold || this.holdWorks() || !this.wedgedInPlace()) return false;
    const inReach=near.filter(o=>!(o.flags & OF.PLAYER) && Math.hypot(o.col-me.col,o.row-me.row)<=REACH);
    // Anything fightable in reach is the trade's to answer, not ours.
    if (!inReach.length || inReach.some(o=>!this.sparedHere(o))) return false;
    const hp=(v ?? c.vitals())?.health,frac=pct(hp),fleeAt=this.safety().fleeAt;
    if (frac==null || frac<fleeAt) return false;
    const now=Date.now(),room=s.world?.room?.num;
    this._spareLures=(this._spareLures??[]).filter(x=>now-x.at<SPARE_LURE_WINDOW_MS);
    if (this._spareLures.filter(x=>x.room===room).length>=SPARE_LURES_PER_ROOM) {
      if (!this._spareLureCapNoted || now-this._spareLureCapNoted>SPARE_LURE_WINDOW_MS) {
        this._spareLureCapNoted=now;
        this.note('spared blocker: lure budget spent in this room; leaving it to the movement ladder',
          {room,lures:SPARE_LURES_PER_ROOM,window_min:SPARE_LURE_WINDOW_MS/60000});
      }
      return false;
    }
    const nameOf=o=>o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
    inReach.sort((a,b)=>Math.hypot(a.col-me.col,a.row-me.row)-Math.hypot(b.col-me.col,b.row-me.row));
    const target=inReach[0],name=nameOf(target);
    const origin={row:me.row,col:me.col},blocked={row:target.row,col:target.col};
    const operation_id=process.pid+'-'+now+'-'+(this._blockerSequence=(this._blockerSequence??0)+1);
    const event=(phase,detail={})=>this.blockerEvent(phase,{operation_id,target:name,target_id:target.id,
      mode:'spared_'+mode,...detail});
    const plan=this.planBlockerLure(target,origin);
    this._spareLures.push({at:now,room});
    if (!plan) {
      event('refusal',{reason:'no reachable refuge outside the needle'});
      return false;
    }
    event('start',{origin,blocked_square:blocked,refuge:plan.spot});
    this.tally.spared_lures=(this.tally.spared_lures||0)+1;
    let provoked=null;
    if (mode==='provoke' && !this.watch?.attack) {
      this.doing='provoking a spared blocker';
      grantProvoke(s,target.id);
      try {
        provoked=await this.fightNow({target:name,exactTargetId:target.id,rounds:1,disengageAt:fleeAt,
          loot:false,holdPosition:true,reach:REACH,weaponPriority:this.weaponPriorityNow(),
          bannedWeapons:this.bannedWeaponsNow()}).catch(e=>({fought:false,note:e.message}));
      } finally { endProvoke(s); }
      event('provoke',{fought:!!provoked?.fought,landed:provoked?.landed_hits??null,killed:!!provoked?.killed});
      if (provoked?.killed) {
        this.tally.spared_killed=(this.tally.spared_killed||0)+1;
        this.note('SPARED BLOCKER DIED TO THE PROVOKING SWING', {target:name,room,
          why:'one swing was meant to draw it, not kill it; spare_blockers "lure" never swings'});
        this.progress('spared blocker gone');
        return true;
      }
      if (provoked?.died) return true;
    }
    this.doing='luring a spared blocker';
    const r=await this.takeSafeSpot('lure a spared creature out of the way',null,
      {source:'recovery',recovery:true,nearestOnly:true,candidateFilter:plan.filter}).catch(e=>({took:false,why:e.message}));
    event('retreat',{took:!!r?.took,cancelled:!!r?.cancelled,refuge:r?.spot??plan.spot,provoked:!!provoked?.fought});
    if (r?.took) {
      this.pendingBlockerLure={operation_id,client:c,generation:s.movementGeneration,room,
        target:name,target_id:target.id,blocked,refuge:plan.spot,until:Date.now()+30000};
      this.observeBlockerLure();
    }
    this.note('spared blocker: backed off so it follows us out of the way',
      {target:name,target_id:target.id,mode,refuge:plan.spot,took:!!r?.took,provoked:!!provoked?.fought});
    return !!(r?.took || provoked?.fought);
  }

  // THE TWO HALVES OF `last_error`'s LIFECYCLE, NAMED, so that the rule can be driven
  // without standing up a keeper. The bug they fix is entirely one of bookkeeping — the
  // recovery path was always correct — and the only way to pin bookkeeping is to be able
  // to ask it a question, which a five-second sleep inside `loop()` made impossible.

  // A COMPLETED PASS ON A LIVE SESSION IS THE RECOVERY, AND IT HAS TO SAY SO.
  //
  // Both halves are required. "Completed" alone is not enough — a pass can finish without
  // touching the wire — so `live` is asked too, because the error class this clears is
  // precisely a session that had gone away. Recorded as a journal line rather than cleared
  // silently: the complaint was that a recovery left no trace, and a field that empties
  // itself with no entry beside it swaps one invisible transition for another.
  notePassSucceeded() {
    if (this.lastError && this.s?.live) {
      this.note('recovered', { after: this.lastError,
                               unwell_for_s: this.lastErrorAt
                                 ? Math.round((Date.now() - this.lastErrorAt) / 1000) : null,
                               failed_passes: this.consecutivePassFailures });
      this.lastError = null;
      this.lastErrorAt = null;
      this.lastErrorLive = null;
    }
    this.consecutivePassFailures = 0;
    return this.lastError;
  }

  // AND THE SET SIDE, STAMPED AND ATTRIBUTED. `live` at the moment of the throw is the
  // whole difference between a self-inflicted reconnect window — `breakOutViaLogoff` nulls
  // the client on purpose and heals on the next pass — and a fault the session was awake
  // for. One boolean in the journal, and the two stop looking identical.
  notePassFailed(e) {
    const live = !!this.s?.live;
    this.lastError = e?.message ?? String(e);
    this.lastErrorAt = Date.now();
    this.lastErrorLive = live;
    this.consecutivePassFailures++;
    this.note('pass failed', { why: this.lastError, live,
                               consecutive: this.consecutivePassFailures });
    return this.lastError;
  }
  // @end 1
}
