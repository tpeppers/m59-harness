#!/usr/bin/env node
// m59-wedge-test.mjs — A WEDGE BROKEN BY A CANCEL IS A WEDGE RE-ISSUED.
//
//   node tools/m59-wedge-test.mjs
//
// Offline. Opens no socket, joins nobody, needs no broker, writes no ledger.
//
// ======================== WHAT THIS PINS ========================
//
// The watchdog's second arm breaks a healthy wedge with `cancelMovement()`, "so the next
// pass can decide with real numbers — this keeper does not decide anything itself". The
// numbers were not real. They were IDENTICAL: same square, same room, same destination,
// same policy. So the next pass issued the same walk, which wedged on the same condition,
// and the arm broke it again. Measured on `acba925`, one character (issue #37):
//
//   93 minutes in room 575 assigned to 586 — 217 passes, 589 wedge-breaks, 28 placement
//   failures all "movement cancelled by a newer command", zero rooms entered.
//
//   18.5 minutes on square 18,18 of room 586 — seven threats in the room, health 22 -> 3,
//   `squares_per_second: 0` across 46 post-mortem frames, every decision-trail entry a
//   variant of "moving to somewhere I can heal", and dead to a centipede mid-"travel".
//   Every rung the ladder had was movement-shaped, and movement was what was not
//   happening.
//
// So this pins three claims, one per suggested fix in the issue:
//   1. THE BREAK CHANGES THE INPUTS. The arm records where it broke a wedge and how many
//      times running it has broken one there (`noteWedgeBreak`), and `travel()` reads that
//      before setting out (`answerWedge`): below the cap the body is sidestepped in a
//      rotating direction first, so the plan starts from a square that has not wedged.
//   2. THE LOOP IS BOUNDED. At WEDGE_REPEAT_CAP the pass gives the walk up out loud — one
//      line, once — and refuses every walk from that place until the hold expires, at
//      which point the count starts fresh rather than the refusal becoming permanent.
//   3. WEDGED AND HURT WITH SOMETHING IN REACH TRADES IN PLACE, ahead of every rung that
//      answers being hurt with distance.
//
// It drives the REAL methods — the module's `tick`, and the autopilot's `answerWedge`,
// `wedgedInPlace` and `tradeInPlaceIfWedged` over a keeper stripped to what they touch —
// and pins the call sites with source checks, because a rung that exists and is never
// reached is the failure the second incident is made of.

import { readFileSync } from 'node:fs';
import * as wd from './m59-watchdog.mjs';
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
const WATCHDOG = readFileSync(new URL('./m59-watchdog.mjs', import.meta.url), 'utf8');
const CAP = wd.WEDGE_REPEAT_CAP;
const R = wd.WATCHDOG_PINNED_SQUARES;

// ------------------------------------------------------------------ 1. the record

console.log('\nthe record — one wedge is one place, and it counts');
{
  const w = wd.freshState();
  ok('a fresh state carries the field', 'wedgeBreak' in w && w.wedgeBreak === null);
  const r1 = wd.noteWedgeBreak(w, { room: 586, col: 18, row: 18, doing: 'travelling', to: 586 }, 1000);
  ok('the first break records one repeat at the place', r1.repeats === 1 && w.wedgeBreak === r1
     && r1.room === 586 && r1.col === 18 && r1.row === 18 && r1.to === 586);
  const r2 = wd.noteWedgeBreak(w, { room: 586, col: 18 + R, row: 18 - R, doing: 'zoning' }, 2000);
  ok('a second break inside the pinned radius is the SAME wedge, counted', r2 === r1 && r1.repeats === 2);
  ok('...keeping where it started and when, and taking the newest doing',
     r1.col === 18 && r1.row === 18 && r1.first_at === 1000 && r1.at === 2000 && r1.doing === 'zoning');
  ok('...and a break with no destination keeps the one already recorded', r1.to === 586);
  const r3 = wd.noteWedgeBreak(w, { room: 586, col: 18 + R + 1, row: 18 }, 3000);
  ok('one square past the radius is a new wedge, counted from one', r3 !== r1 && r3.repeats === 1 && r3.col === 18 + R + 1);
  const r4 = wd.noteWedgeBreak(w, { room: 575, col: 18 + R + 1, row: 18 }, 4000);
  ok('the same square in a different room is a different wedge', r4.repeats === 1 && r4.room === 575);
  ok('sameWedgePlace refuses a missing room rather than matching on null',
     !wd.sameWedgePlace({ room: null, col: 1, row: 1 }, { room: null, col: 1, row: 1 }));
}

console.log('\nthe advice — vary below the cap, give up at it, nothing from elsewhere');
{
  const w = wd.freshState();
  ok('nothing recorded: no advice', wd.wedgeAdvice(w, { room: 1, col: 1, row: 1 }) === null);
  wd.noteWedgeBreak(w, { room: 586, col: 18, row: 18, doing: 'travelling', to: 586 }, 0);
  const a = wd.wedgeAdvice(w, { room: 586, col: 19, row: 18 }, 5000);
  ok('one break here: vary, with the count and how long this has gone on',
     a?.verdict === 'vary' && a.repeats === 1 && a.cap === CAP && a.wedged_for_ms === 5000 && a.to === 586);
  ok('asked from somewhere else: null, and the record is untouched — the function is pure',
     wd.wedgeAdvice(w, { room: 586, col: 18 + R + 1, row: 18 }) === null && w.wedgeBreak.repeats === 1);
  for (let i = 1; i < CAP; i++) wd.noteWedgeBreak(w, { room: 586, col: 18, row: 18 }, i * 1000);
  const g = wd.wedgeAdvice(w, { room: 586, col: 18, row: 18 });
  ok(`at the cap (${CAP}): give_up`, g?.verdict === 'give_up' && g.repeats === CAP);
  ok('the cap is read from the environment with a default, not hard-wired',
     /WEDGE_REPEAT_CAP = Number\(process\.env\.M59_WEDGE_REPEAT_CAP \|\| [\d_]+\)/.test(WATCHDOG));
}

// ------------------------------------------------------------------ 2. the arm records it

// A host shaped like m59-watchdog-test's, pinned and healthy: doing travelling, blocked
// for longer than the handbrake, full health, standing on one square.
function host({ hp = 20, max = 20, blockedMs = 9000, doing = 'travelling', room = 586,
                col = 18, row = 18 } = {}) {
  const notes = [];
  let cancelled = 0;
  const self = { col, row };
  const h = {
    doing, hold: null, inert: null, passes: 1, tally: {},
    passStartedAt: Date.now() - blockedMs, lastFrameAt: 0,
    s: { client: { vitals: () => ({ health: { value: hp, max } }), self, room: { id: 9001 }, state: 'game' },
         world: { room: { num: room } },
         live: true,
         cancelMovement: () => { cancelled++; return { cancelled: true, interrupted: 1 }; } },
    safety: () => ({ fleeAt: 0.4 }),
    recordFrame(why) { this.lastFrameAt = Date.now(); },
    note: (what, detail) => notes.push({ what, detail }),
    progress: () => {},
    wedgeTarget: () => 586,
    notes, self, get cancels() { return cancelled; },
  };
  h.watch = wd.freshState();
  return h;
}

// One pinned episode: pulse twice on the square, tick once to anchor, age the anchor past
// WATCHDOG_PINNED_MS, tick again so the arm fires.
function pinAndBreak(h) {
  const t = Date.now();
  wd.pulse(h, t - 2000, h.s.client.vitals().health);
  wd.pulse(h, t - 1000, h.s.client.vitals().health);
  h.passes += 1;
  wd.tick(h);
  h.watch.pinnedSince = Date.now() - wd.WATCHDOG_PINNED_MS - 1000;
  h.passes += 1;
  wd.tick(h);
}

console.log('\nthe module arm — every break at the same place is one more repeat');
{
  const h = host();
  pinAndBreak(h);
  const b = h.watch.wedgeBreak;
  ok('the arm cancelled once and recorded the break where the anchor was',
     h.cancels === 1 && b && b.repeats === 1 && b.room === 586 && b.col === 18 && b.row === 18,
     JSON.stringify(b));
  ok('...with what the body was doing and where it was going', b?.doing === 'travelling' && b?.to === 586);
  const note = h.notes.find(n => n.what.startsWith('WATCHDOG — broke a wedge'));
  ok('the note carries the count and the cap', note?.detail.repeats_here === 1 && note?.detail.cap === CAP);
  ok('a first break says nothing about what comes next', note?.detail.note === undefined);
  h.notes.length = 0;
  pinAndBreak(h);
  ok('a second episode at the same square is repeat 2, not a fresh record',
     h.cancels === 2 && h.watch.wedgeBreak === b && b.repeats === 2);
  const note2 = h.notes.find(n => n.what.startsWith('WATCHDOG — broke a wedge'));
  ok('...and the note now says the next pass will sidestep', /sidesteps/.test(note2?.detail.note ?? ''));
  h.self.col = 18 + R + 3;
  h.watch.pulses.length = 0;
  pinAndBreak(h);
  ok('breaking one somewhere else starts a new record', h.watch.wedgeBreak !== b && h.watch.wedgeBreak.repeats === 1);
  ok('the pinned interrupt tally still climbs as before', h.tally.watchdog_pinned_interrupts === 3);
}
{
  const h = host();
  for (let i = 0; i < CAP; i++) pinAndBreak(h);
  const last = h.notes.filter(n => n.what.startsWith('WATCHDOG — broke a wedge')).pop();
  ok(`at the cap the arm's own note says the next pass gives up`, h.watch.wedgeBreak.repeats === CAP
     && /gives up/.test(last?.detail.note ?? ''));
  ok('the arm still decided nothing — it cancelled, once per episode, and that is all',
     h.cancels === CAP);
}
ok('the autopilot\'s own copy of the arm records the same way',
   /watchdog\.noteWedgeBreak\(w, \{ room: place\.room, col: place\.col, row: place\.row/.test(AUTOPILOT));

// ------------------------------------------------------------------ 3. the pass's half

// A keeper stripped to what answerWedge / wedgedInPlace / tradeInPlaceIfWedged touch.
function keeper({ col = 18, row = 18, room = 586, hp = 3, max = 22, fleeAt = 0.7,
                 retreatMoves = true,
                 // The session's memory of how this room was entered — what rungs 2 and 3 of
                 // the back-up ladder are built on. Absent by default, because a character
                 // that has not crossed a boundary this session genuinely has no such memory
                 // and the ladder must degrade to the breadcrumbs rather than inventing one.
                 enteredVia = null, travelWorks = true, walkWorks = true,
                 // Rung 1.5. null = the session has no such method at all, false = it has
                 // one and there is no rail to rejoin, true = it rejoins.
                 railWorks = null, onward = { row: 4, col: 9 } } = {}) {
  const notes = [], walks = [], fights = [], retreats = [], walls = [], travels = [],
        rails = [], onwardAsks = [];
  const ap = Object.create(Autopilot.prototype);
  const self = { col, row };
  ap.watch = wd.freshState();
  ap.wedgeHold = null;
  ap.tally = {};
  ap.policy = {};
  ap.inert = null;
  ap.hold = null;
  ap.holdWorks = () => false;
  ap.safety = () => ({ fleeAt });
  ap.who = () => null;                         // recordEvent writes nothing for a nameless keeper
  ap.recordFrame = () => {};
  ap.note = (what, detail) => notes.push({ what, detail });
  ap.progress = () => {};
  ap.weaponPriorityNow = () => null;
  ap.fightInPlace = async (target, name) => { fights.push({ target, name }); return { killed: false }; };
  ap.s = {
    client: { self, room: { id: 9001 }, rsc: { get: id => ({ 1: 'centipede', 2: 'giant rat' })[id] ?? '' },
              vitals: () => ({ health: { value: hp, max } }) },
    world: { room: { num: room } },
    // The fake mover MOVES the body, so "did the sidestep change the start square" is a
    // real question with a real answer rather than a fixture agreeing with itself.
    walkTo: async (c, r, opts) => {
      walks.push({ col: c, row: r, opts });
      if (!walkWorks) return { arrived: false, reason: 'every heading refused' };
      self.col = c; self.row = r; return { arrived: true };
    },
    enteredVia,
    // Rung 3. The fake actually changes the room, so "did it end up next door" is a real
    // question — a fixture that only records the call would agree with itself.
    travel: async (to, opts) => {
      travels.push({ to, opts });
      if (!travelWorks) return { arrived: false, reason: 'no route' };
      ap.s.world.room.num = to; ap.s.client.room.id = to;
      return { arrived: true };
    },
    // GIVING UP NOW BACKS OFF. The fake trail walks the body two squares back the way it
    // came, which is what a real breadcrumb retreat does — every step of it a move the
    // validator already accepted on the way in.
    retreatAlongBreadcrumbs: async (opts) => {
      retreats.push(opts ?? {});
      if (retreatMoves) { self.col -= 2; self.row -= 1; }
      return { moved: retreatMoves, steps: retreatMoves ? 2 : 0 };
    },
    // RUNG 1.5, present only when the fixture asks for it: a session that has never
    // travelled a baked route genuinely has no such lane, and the ladder must fall through
    // to the blind unwind rather than invent one.
    ...(railWorks == null ? {} : {
      retreatToRail: async (opts) => {
        rails.push(opts ?? {});
        if (!railWorks) return { moved: false, reason: 'no rail to rejoin' };
        self.col -= 1; self.row -= 1;
        return { moved: true, steps: 1, rejoined: true, rail_squares: 4 };
      },
    }),
  };
  // The memoised first-hop lookup rung 1.5 aims with. null is the honest answer for a room
  // with no onward route, and the rung must decline rather than aim at the destination.
  //
  // TAKES ITS ARGUMENTS, because a stub that ignores them cannot fail when the caller swaps
  // them. The signature is `onwardExit(roomNum, destination, opts)`, and asking it the other
  // way round is a real mistake with no symptom here — the fixture would happily answer.
  // `cachedOnly` is recorded for the same reason: this is the survival ladder, and an
  // unqualified ask can run the exits flood for seconds on the loop 21 characters share.
  ap.onwardExit = (roomNum, destination, opts) => {
    onwardAsks.push({ roomNum, destination, cachedOnly: opts?.cachedOnly === true });
    return onward;
  };
  ap.takeSafeSpot = async (why, q, opts) => { walls.push({ why, opts }); return { took: true }; };
  ap.threat = () => ({ adjacent: [], near: [], engaged: 0, landing: 0, names: [] });
  return { ap, notes, walks, fights, self, retreats, walls, travels, rails, onwardAsks };
}
const breakAt = (ap, n, place = { room: 586, col: 18, row: 18 }, doing = 'travelling') => {
  for (let i = 0; i < n; i++) wd.noteWedgeBreak(ap.watch, { ...place, doing, to: 586 }, Date.now() - (n - i) * 1000);
};

console.log('\nanswerWedge — nothing recorded, nothing changes');
{
  const { ap, walks } = keeper();
  const r = await ap.answerWedge(586);
  ok('no record: null, and the mover was not touched', r === null && walks.length === 0);
}

console.log('\nanswerWedge — below the cap, the walk starts from a different square');
{
  const { ap, notes, walks, self } = keeper();
  breakAt(ap, 1);
  const r1 = await ap.answerWedge(586);
  ok('one break here: the body is sidestepped before the plan',
     r1?.sidestepped === true && r1.moved === true && walks.length === 1, JSON.stringify(r1));
  ok('...two squares, so the step clears the melee disc and the endpoint slide',
     walks[0] && Math.max(Math.abs(walks[0].col - 18), Math.abs(walks[0].row - 18)) === 2);
  ok('...and it is a short walk, not a journey', walks[0]?.opts?.maxSteps === 6);
  const n1 = notes.find(n => n.what === 'wedge — sidestepping before re-planning');
  ok('the note says where from, where to, and that it moved',
     n1?.detail.from === '18,18' && n1.detail.moved === true && n1.detail.repeats === 1 && n1.detail.wanted === 586);
  ok('the tally counts it', ap.tally.wedge_sidesteps === 1);
  ok('the record is kept — a sidestep is inside the radius, so a further wedge counts on',
     ap.watch.wedgeBreak?.repeats === 1);
  // The same wedge again, one square over.
  wd.noteWedgeBreak(ap.watch, { room: 586, col: self.col, row: self.row, doing: 'travelling' });
  const r2 = await ap.answerWedge(586);
  ok('the second break aims a DIFFERENT way', r2?.direction && r2.direction !== r1.direction
     && walks.length === 2, `${r1?.direction} then ${r2?.direction}`);
}

console.log('\nanswerWedge — the body got somewhere, so the wedge is over');
{
  const { ap, walks, self } = keeper();
  breakAt(ap, 2);
  self.col = 18 + R + 1;
  const r = await ap.answerWedge(586);
  ok('a record about somewhere else answers null and is dropped', r === null && ap.watch.wedgeBreak === null && walks.length === 0);
}
{
  const { ap, walks } = keeper();
  breakAt(ap, 2);
  ap.s.client.self = null;
  const r = await ap.answerWedge(586);
  ok('an unknown position is not evidence of having moved — the record is kept',
     r === null && ap.watch.wedgeBreak?.repeats === 2 && walks.length === 0);
}

console.log('\nanswerWedge — at the cap the walk is refused, once, out loud, for a while');
{
  const { ap, notes, walks } = keeper();
  breakAt(ap, CAP);
  const r = await ap.answerWedge(586);
  ok('at the cap: refused and gave up, no sidestep, no walk',
     r?.refused === true && r.gave_up === true && r.repeats === CAP && walks.length === 0, JSON.stringify(r));
  const g = notes.filter(n => n.what.startsWith('WATCHDOG — gave up'));
  ok('one line, naming the square, the count and the destination',
     g.length === 1 && g[0].detail.square === '18,18' && g[0].detail.room === 586 && g[0].detail.wanted === 586
     && /went nowhere/.test(g[0].what));
  ok('the hold is set from here, with an expiry', ap.wedgeHold && ap.wedgeHold.repeats === CAP
     && ap.wedgeHold.until > Date.now() && ap.tally.wedge_giveups === 1);
  const r2 = await ap.answerWedge(586);
  ok('the next pass is refused fast — and does NOT write another line',
     r2?.refused === true && notes.filter(n => n.what.startsWith('WATCHDOG — gave up')).length === 1);
  ok('...the refusal says how long is left', /holding for \d+s more/.test(r2?.why ?? ''));
  ok('while held, wedgedInPlace still says yes', !!ap.wedgedInPlace());
  ap.wedgeHold.until = Date.now() - 1;
  const r3 = await ap.answerWedge(586);
  ok('the hold expiring drops the record: a fresh count, not a permanent refusal',
     r3 === null && ap.wedgeHold === null && ap.watch.wedgeBreak === null);
}
{
  const { ap, self } = keeper();
  breakAt(ap, CAP);
  await ap.answerWedge(586);
  self.col = 18 + R + 1;
  const r = await ap.answerWedge(586);
  ok('moving away from a held place ends the hold', r === null && ap.wedgeHold === null);
}
ok('the hold length is read from the environment with a default',
   /WEDGE_GIVEUP_HOLD_MS = Number\(process\.env\.M59_WEDGE_GIVEUP_HOLD_MS \|\| [\d_]+\)/.test(WATCHDOG));

console.log('\nwedgedInPlace — four signals, because the arm only fires at full health');
{
  const { ap } = keeper();
  ok('a fresh keeper is not wedged', ap.wedgedInPlace() === null);
  breakAt(ap, 1);
  ok('a break recorded here says so', /1 walk/.test(ap.wedgedInPlace()?.why ?? ''));
  ap.watch.wedgeBreak = null;
  ap.watch.wedged = { since: Date.now() - 5000 };
  ok('the same square for five seconds is not a wedge yet', ap.wedgedInPlace() === null);
  ap.watch.wedged = { since: Date.now() - wd.WATCHDOG_PINNED_MS - 1000 };
  ok('the same square past WATCHDOG_PINNED_MS is — with no arm having fired',
     /same square/.test(ap.wedgedInPlace()?.why ?? ''));
  ap.watch.wedged = null;
  ap.watch.pinnedSince = Date.now() - wd.WATCHDOG_PINNED_MS - 1000;
  ok('so is an anchor that old', /no ground/.test(ap.wedgedInPlace()?.why ?? ''));

  // THE ANCHOR GATE HERE IS THE SURVIVAL RUNGS', NOT THE LADDER'S — pinned because it was
  // briefly changed to the ladder's shorter clock, which does not reach the ladder at all.
  //
  // `wedgedInPlace` has exactly two callers, `escapeIfWedgedAndHurt` and
  // `tradeInPlaceIfWedged`. Neither is `backUpToUnstick`. Shortening this gate does not make
  // the escape ladder run sooner; it makes a hurt character stop travelling and swing, and
  // pre-empts the panic-logoff rung below that. The ladder is reached from `answerWedge`,
  // off `wedgeBreak`, which the healthy arm writes on WEDGE_LADDER_MS.
  ap.watch.pinnedSince = Date.now() - wd.WATCHDOG_PINNED_MS + 1000;
  ok('an anchor younger than WATCHDOG_PINNED_MS is not a wedge', ap.wedgedInPlace() === null);
  ok('and a wedge is recorded for the ladder sooner than the survival rungs fire',
     wd.WEDGE_LADDER_MS < wd.WATCHDOG_PINNED_MS);
}

console.log('\ntradeInPlaceIfWedged — hurt, wedged, something in reach: swing, do not walk');
{
  const near = [{ id: 8, col: 17, row: 17, nameRsc: 2 }, { id: 9, col: 19, row: 18, nameRsc: 1 }];
  const v = { health: { value: 3, max: 22 } };
  {
    const { ap, notes, fights } = keeper();
    ap.watch.wedged = { since: Date.now() - wd.WATCHDOG_PINNED_MS - 1000 };
    const r = await ap.tradeInPlaceIfWedged({ near, v });
    ok('fires: 3 of 22, wedged, two in reach', r === true && fights.length === 1);
    ok('...at the NEAREST one, by name and by id', fights[0].target.id === 9 && fights[0].name === 'centipede');
    const n = notes.find(x => x.what === 'wedged and hurt with something in reach — trading in place');
    ok('...and says why in the trail', !!n && n.detail.target === 'centipede' && n.detail.in_reach === 2
       && n.detail.health === '3/22');
    ok('...counted', ap.tally.wedge_trades === 1);
  }
  {
    const { ap, fights } = keeper();
    ok('not wedged: not this rung', await ap.tradeInPlaceIfWedged({ near, v }) === false && fights.length === 0);
  }
  {
    const { ap, fights } = keeper();
    ap.watch.wedged = { since: Date.now() - wd.WATCHDOG_PINNED_MS - 1000 };
    ok('nothing in reach: nothing to trade with', await ap.tradeInPlaceIfWedged({ near: [], v }) === false && fights.length === 0);
    ok('above the flee line: the ordinary fight rung owns it',
       await ap.tradeInPlaceIfWedged({ near, v: { health: { value: 20, max: 22 } } }) === false && fights.length === 0);
    ap.holdWorks = () => true;
    ok('behind a working wall: the rest rung owns it', await ap.tradeInPlaceIfWedged({ near, v }) === false);
    ap.holdWorks = () => false;
    ap.policy.tradeInPlaceWhenWedged = false;
    ok('switched off per character: off', await ap.tradeInPlaceIfWedged({ near, v }) === false);
  }
  {
    const { ap, fights } = keeper();
    ap.watch.wedged = { since: Date.now() - wd.WATCHDOG_PINNED_MS - 1000 };
    ap.fightInPlace = async () => { throw new Error('socket went away'); };
    const r = await ap.tradeInPlaceIfWedged({ near, v });
    ok('a swing that throws is handled, not a pass that dies', r === true && fights.length === 0);
  }
  const fip = AUTOPILOT.slice(AUTOPILOT.indexOf('  fightInPlace(target, name = null) {'));
  ok('the swing holds position and never disengages — moving is the thing that is not working',
     /holdPosition: true/.test(fip.slice(0, 600)) && /disengageAt: 0/.test(fip.slice(0, 600)));
}

// ------------------------------------------------------------------ 4. the call sites

console.log('\nthe call sites — a rung that is never reached is the second incident');
{
  const travel = AUTOPILOT.indexOf('  async travel(room, opts) {');
  const answer = AUTOPILOT.indexOf('await this.answerWedge(Number(room))', travel);
  const restFirst = AUTOPILOT.indexOf('await this.restBeforeSettingOut()', travel);
  ok('travel() asks answerWedge at the single gate, before setting out',
     travel > 0 && answer > travel && restFirst > answer);
  const refused = AUTOPILOT.indexOf('wedged: true, gave_up: true', answer);
  ok('...and a give-up refuses the journey the way the confinement does', refused > answer && refused < restFirst);

  const ladder = AUTOPILOT.indexOf('  async passFleeAndRest(ctx) {');
  const trade = AUTOPILOT.indexOf('await this.tradeInPlaceIfWedged({ near, v })', ladder);
  const town = AUTOPILOT.indexOf('hurt in the open — running for a town rather than playing dead', ladder);
  const heal = AUTOPILOT.indexOf('not waiting this out — moving to somewhere I can heal', ladder);
  const exit = AUTOPILOT.indexOf('const mustLeaveForHealth = belowRoomRetreatHealth', ladder);
  ok('the ladder trades in place BEFORE running for a town', ladder > 0 && trade > ladder && town > trade);
  ok('...before "moving to somewhere I can heal"', heal > trade);
  ok('...and before taking the nearest exit', exit > trade);

  const arm = WATCHDOG.indexOf('WATCHDOG — broke a wedge that was not hurting anybody');
  ok('the module arm records the break before it writes the note', WATCHDOG.lastIndexOf('noteWedgeBreak(w,', arm) > 0);
  ok('the status snapshot exposes the wedge, so one poll shows the loop', /^\s+wedge: this\.watch\?\.wedgeBreak \? \{/m.test(AUTOPILOT));
}

// ---------------------------------------------------------------------------
// GIVING UP MUST NOT MEAN STANDING THERE.
//
// The hold exists because "cancelling changes nothing when the inputs do not", and for a
// long time its answer was to stop issuing walks and wait 120 seconds where it stood. On a
// hunting floor that is fine; on the road it is the death. Measured over 24 hours on prod:
// 70 of 70 deaths were characters NOT SWINGING, most of them not moving either, wedged in
// the Cragged Mountains corridor while trolls and black spiders arrived.
//
// Standing still does not change the inputs either. Backing out along the trail does, which
// is the thing the hold was reaching for and could not do from a standstill.
console.log('\ngiving up backs off along the trail instead of waiting where it wedged');
{
  const k = keeper({ hp: 20, max: 22 });            // healthy: above the flee line
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  const before = { col: k.self.col, row: k.self.row };
  const r = await k.ap.answerWedge(586);
  ok('it still gives up', r?.gave_up === true, JSON.stringify(r));
  ok('but it retreated first', k.retreats.length === 1);
  ok('the body actually moved off the wedged square',
     k.self.col !== before.col || k.self.row !== before.row,
     `${before.col},${before.row} -> ${k.self.col},${k.self.row}`);
  ok('and put a wall at its back to wait behind', k.walls.length === 1,
     JSON.stringify(k.walls));
  // THE POINT OF MOVING. The hold is anchored where it ENDED UP, so `sameWedgePlace` reads
  // false at the new square and the next travel is planned rather than refused — from
  // ground that has not already failed.
  ok('the hold is anchored where it ended up, not where it failed',
     k.ap.wedgeHold.col === k.self.col && k.ap.wedgeHold.row === k.self.row,
     JSON.stringify({ hold: [k.ap.wedgeHold.col, k.ap.wedgeHold.row], now: [k.self.col, k.self.row] }));
  ok('and it records that it backed off', k.ap.wedgeHold.backed_off === true);
  const note = k.notes.find(n => /gave up/.test(n.what));
  ok('the operator note says so', note && typeof note.detail.backed_off === 'object',
     JSON.stringify(note?.detail?.backed_off));
}

console.log('\nbut not below the flee line — the survival ladder owns the body down there');
{
  // hp 3 of 22 is 14%, under the 70% flee line this fixture uses. A wedge-retreat there
  // would be a second opinion about an emergency the ladder is already handling.
  const k = keeper({ hp: 3, max: 22 });
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  const r = await k.ap.answerWedge(586);
  ok('it gives up', r?.gave_up === true);
  ok('and does NOT retreat', k.retreats.length === 0);
  ok('nor take a wall', k.walls.length === 0);
}

console.log('\na retreat that cannot move is not a failure — the hold still bounds the loop');
{
  const k = keeper({ hp: 20, max: 22, retreatMoves: false });
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  const before = { col: k.self.col, row: k.self.row };
  const r = await k.ap.answerWedge(586);
  ok('it tried', k.retreats.length === 1);
  ok('it still gives up rather than throwing', r?.gave_up === true);
  ok('the hold anchors where it still is', k.ap.wedgeHold.col === before.col
     && k.ap.wedgeHold.row === before.row);
  ok('and says it did not back off', k.ap.wedgeHold.backed_off === false);
  // No wall either: a wall taken without moving is the same square with a nicer name.
  ok('no wall was taken', k.walls.length === 0);
}

// ------------------------------------------------------------------ 4. the back-up ladder
//
// ANIMAL, THE CRAGGED MOUNTAINS, 2026-09-05. Wedged on the eastern side with no realistic
// chance of ever getting out, while two fleet-mates crossed the same room in the same minutes
// without noticing anything. Taken over by hand and walked back the way he came, he then
// travelled to Castle Victoria perfectly normally.
//
// Nothing was wrong with the character, the route or the map. He was standing somewhere the
// router could not plan out of, and every remedy tried to solve that WITHOUT LEAVING THE
// SQUARE. Twelve breadcrumbs is the right answer to a bounce and no answer at all to that.
console.log('\nthe back-up ladder — breadcrumbs, then the entry square, then the room next door');
{
  const k = keeper({ hp: 20, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  const out = await k.ap.backUpToUnstick('test');
  ok('the first back-up in a room is the cheap one', out.rung === 1, JSON.stringify(out.rung));
  ok('...so only the breadcrumbs ran', k.retreats.length === 1 && k.walks.length === 0
     && k.travels.length === 0);
  ok('and it reports that the body moved', out.freed === true);
}
{
  // The breadcrumbs did nothing, and this room has already needed one back-up. Rung 2.
  const k = keeper({ hp: 20, max: 22, retreatMoves: false,
                     enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  k.ap.backUps = [{ room: 586, col: 18, row: 18, at: Date.now() }];
  const out = await k.ap.backUpToUnstick('test');
  ok('a second back-up in the same room climbs to the entry square', out.rung === 2);
  ok('...and walks to the door it came in by, not to a guess',
     k.walks.length === 1 && k.walks[0].col === 4 && k.walks[0].row === 30,
     JSON.stringify(k.walks));
  ok('...but does not leave the room at rung 2', k.travels.length === 0);
  ok('the body is on the entry square now', k.self.col === 4 && k.self.row === 30);
}
{
  // Twice already, and the entry square is not enough either. Rung 3: leave.
  const k = keeper({ hp: 20, max: 22, retreatMoves: false, walkWorks: false,
                     enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  k.ap.backUps = [{ room: 586, at: Date.now() }, { room: 586, at: Date.now() }];
  const out = await k.ap.backUpToUnstick('test');
  ok('a third goes back through the door into the previous room', out.rung === 3);
  ok('...to the room it came FROM, one hop, not a journey',
     k.travels.length === 1 && k.travels[0].to === 585 && k.travels[0].opts?.maxHops === 2,
     JSON.stringify(k.travels));
  ok('...and it ended up there', out.ended?.room === 585);
  const r3 = out.tried.find(t => t.rung === 3);
  ok('the record says which rung actually worked', r3?.worked === true);
}
{
  // A ROOM WITH NO ENTRY MEMORY DEGRADES, IT DOES NOT INVENT ONE. A character that has not
  // crossed a boundary this session has no known-good square to go back to, and guessing one
  // would be exactly the coarse-grid escape hatch this repository refuses.
  const k = keeper({ hp: 20, max: 22, retreatMoves: false });
  k.ap.backUps = [{ room: 586, at: Date.now() }, { room: 586, at: Date.now() }];
  const out = await k.ap.backUpToUnstick('test');
  ok('rung 3 is allowed but there is nowhere known to go back to', out.rung === 3);
  ok('...so nothing is walked to and nothing is crossed',
     k.walks.length === 0 && k.travels.length === 0);
  ok('...and it says so rather than claiming success', out.freed === false);
}
{
  // The memory is about a DIFFERENT room — we have crossed since. Using it would walk to a
  // square that means nothing here.
  const k = keeper({ hp: 20, max: 22, retreatMoves: false,
                     enteredVia: { room: 599, from: 598, door: { col: 4, row: 30 } } });
  k.ap.backUps = [{ room: 586, at: Date.now() }];
  const out = await k.ap.backUpToUnstick('test');
  ok('an entry memory about another room is not used', k.walks.length === 0);
}
{
  const k = keeper({ hp: 3, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  k.ap.backUps = [{ room: 586, at: Date.now() }, { room: 586, at: Date.now() }];
  const out = await k.ap.backUpToUnstick('test');
  ok('below the flee line the ladder does not run at all', out.attempted === false);
  ok('...nothing moved the body', k.retreats.length === 0 && k.walks.length === 0
     && k.travels.length === 0);
}
{
  // THE COUNT IS PER ROOM, AND IT AGES OUT. A character that bounces between three bad
  // squares in one room is having one problem, not three — answering each of them with the
  // cheap rung is how it spends ten minutes there. But an hour later it is weather again.
  const k = keeper({ hp: 20, max: 22 });
  k.ap.backUps = [{ room: 586, at: Date.now() - 11 * 60_000 },
                  { room: 586, at: Date.now() - 12 * 60_000 }];
  ok('back-ups older than the window do not count', k.ap.stuckRung({ room: 586 }) === 1);
  k.ap.backUps = [{ room: 585, at: Date.now() }, { room: 584, at: Date.now() }];
  ok('nor do back-ups in other rooms', k.ap.stuckRung({ room: 586 }) === 1);
  k.ap.backUps = [{ room: 586, at: Date.now() }, { room: 586, at: Date.now() },
                  { room: 586, at: Date.now() }, { room: 586, at: Date.now() }];
  ok('and the ladder stops at three — there is no fourth rung', k.ap.stuckRung({ room: 586 }) === 3);
}

console.log('\nthe give-up uses the ladder, and does not pin a wall in the room it just left');
{
  const k = keeper({ hp: 20, max: 22, retreatMoves: false, walkWorks: false,
                     enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  k.ap.backUps = [{ room: 586, at: Date.now() }, { room: 586, at: Date.now() }];
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  const r = await k.ap.answerWedge(586);
  ok('it gave up and left the room', r?.gave_up === true && k.travels.length === 1);
  // A wall in the room we deliberately left would fight the journey about to re-plan.
  ok('no wall was taken in the room it retreated out of', k.walls.length === 0,
     JSON.stringify(k.walls));
  const note = k.notes.find(n => /gave up/.test(n.what));
  ok('the operator note carries the rung that was reached',
     note?.detail?.backed_off?.rung === 3, JSON.stringify(note?.detail?.backed_off));
}

// ------------------------------------------------------------------ 5. survival's own rung
//
// THE HOLE THIS CLOSES. `tradeInPlaceIfWedged` argues that "every rung from here is
// movement-shaped and the body has not moved, so a swing is the only rung left that changes
// anything" — and that was true of every rung the ladder had, because every one of them
// tries to reach somewhere NEW. Going somewhere OLD is a different question and nothing was
// asking it. A character wedged AND below the flee line is the 70-of-70 not-swinging death:
// the ladder correctly rejected freeze, rest and the town trip, then traded blows with
// something that was beating it, because the option that would have worked was withheld.
//
// It is OFFERED to survival rather than taking the body from it: it runs as a rung of
// passFleeAndRest, on survival's clock, and returns false so the trade happens if it cannot
// move. The four protected faculties keep the body throughout.
console.log('\nthe survival ladder may back out — the flee line is not a wall to its owner');
{
  const k = keeper({ hp: 3, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  const out = await k.ap.backUpToUnstick('test', { owner: 'survival' });
  ok('survival is allowed below the flee line', out.attempted === true, JSON.stringify(out));
  ok('...and the row records who asked', out.owner === 'survival');
}
{
  const k = keeper({ hp: 3, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  const out = await k.ap.backUpToUnstick('test');
  ok('a MOVEMENT caller is still refused down there — this is the Cccc rule',
     out.attempted === false && /survival ladder owns the body/.test(out.why));
}

console.log('\nescapeIfWedgedAndHurt — the rung itself');
{
  const k = keeper({ hp: 3, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);              // so wedgedInPlace() says yes
  const near = [{ id: 7, col: 18, row: 19, nameRsc: 1 }];
  const handled = await k.ap.escapeIfWedgedAndHurt({ near, v: { health: { value: 3, max: 22 } } });
  ok('it handles the pass when it gets the body out', handled === true);
  ok('the body actually moved', k.self.col !== 18 || k.self.row !== 18);
  const n = k.notes.find(n => /backed out the way we came/.test(n.what));
  ok('and it says so, with the health and the reach that justified it',
     n && n.detail.in_reach === 1 && n.detail.health === '3/22', JSON.stringify(n?.detail));
  ok('the tally counts an escape', k.ap.tally.wedge_escapes === 1);
}
{
  // NOTHING IN REACH IS NOT AN EMERGENCY. Being wedged and merely hurt is the ordinary
  // wedge, and the movement side already answers it — this rung is for being wedged while
  // something is hitting us.
  const k = keeper({ hp: 3, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  ok('nothing in reach: not this rung',
     await k.ap.escapeIfWedgedAndHurt({ near: [], v: { health: { value: 3, max: 22 } } }) === false);
}
{
  const k = keeper({ hp: 20, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  const near = [{ id: 7, col: 18, row: 19, nameRsc: 1 }];
  ok('above the flee line the ordinary rungs are right, not this one',
     await k.ap.escapeIfWedgedAndHurt({ near, v: { health: { value: 20, max: 22 } } }) === false);
}
{
  const k = keeper({ hp: 3, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  k.ap.holdWorks = () => true;                     // behind a proven wall: resting is right
  const near = [{ id: 7, col: 18, row: 19, nameRsc: 1 }];
  ok('behind a working wall it stands down',
     await k.ap.escapeIfWedgedAndHurt({ near, v: { health: { value: 3, max: 22 } } }) === false);
}
{
  // IT MUST FALL THROUGH TO THE TRADE RATHER THAN EATING THE PASS. A back-out that cannot
  // move is not an answer, and the swing below is still strictly better than standing there.
  const k = keeper({ hp: 3, max: 22, retreatMoves: false, walkWorks: false, travelWorks: false,
                     enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  k.ap.backUps = [{ room: 586, at: Date.now() }, { room: 586, at: Date.now() }];
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  const near = [{ id: 7, col: 18, row: 19, nameRsc: 1 }];
  const handled = await k.ap.escapeIfWedgedAndHurt({ near, v: { health: { value: 3, max: 22 } } });
  ok('it tried every rung', k.retreats.length === 1 && k.walks.length === 1 && k.travels.length === 1);
  ok('...and reports false so the trade still happens', handled === false);
}
{
  const k = keeper({ hp: 3, max: 22, enteredVia: { room: 586, from: 585, door: { col: 4, row: 30 } } });
  breakAt(k.ap, wd.WEDGE_REPEAT_CAP);
  k.ap.policy.backUpWhenWedged = false;
  const near = [{ id: 7, col: 18, row: 19, nameRsc: 1 }];
  ok('back_up_when_wedged: false switches it off',
     await k.ap.escapeIfWedgedAndHurt({ near, v: { health: { value: 3, max: 22 } } }) === false);
  ok('...and then nothing was even attempted', k.retreats.length === 0);
}
// THE LADDER ASKS IT FIRST. Order is the whole point: getting out of reach beats swinging at
// something that is beating us, and the trade is what happens when escape is impossible.
{
  const esc = AUTOPILOT.indexOf('await this.escapeIfWedgedAndHurt({ near, v })');
  const trade = AUTOPILOT.indexOf('await this.tradeInPlaceIfWedged({ near, v })');
  ok('passFleeAndRest asks escape before trade', esc > 0 && trade > 0 && esc < trade,
     `escape@${esc} trade@${trade}`);
}
// AND BOTH KEYS ARE REACHABLE FROM A TOOL ARGUMENT. `trade_in_place_when_wedged` was
// documented as a per-character switch for as long as the rung existed and was never wired
// to anything — the exact shape of `purpose` missing from a schema for a year.
{
  const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  for (const k of ['back_up_when_wedged', 'trade_in_place_when_wedged', 'escape_ladder']) {
    ok(`${k} is declared in the autopilot tool's schema`, BROKER.includes(`${k}: { type: 'boolean'`));
    ok(`...and actually applied`, BROKER.includes(`a.${k} !== undefined`));
  }
}

// ---------------------------------------------------------------------------
// RUNG 1.5 THROUGH THE LADDER, NOT IN ISOLATION.
//
// m59-breadcrumb-test exercises `retreatToRail` against a hand-stubbed rail. That says
// nothing about whether the ladder ever CALLS it, and the first version of this rung was
// unreachable for two independent reasons that both read as correct: it was ordered after a
// rung that always moves, behind a `!moved()` guard that therefore never opened; and it
// asked `anchorFor` for the journey's DESTINATION when `anchorFor` only answers for an
// ADJACENT room, so it resolved only on the last hop of a trip. Neither is visible from a
// unit test of the method. These cases exist to fail when the rung stops being reached.
console.log('\nescape_ladder: false leaves this character out of the ladder entirely');
{
  // The A/B lever. It has to skip the WHOLE ladder, not merely a rung, and it must not be
  // confused with back_up_when_wedged -- which gates escapeIfWedgedAndHurt, the survival
  // rung below the flee line, and is a different population.
  {
    const { ap, retreats, rails, walks, travels } = keeper({ hp: 20, railWorks: true });
    ap.policy.escapeLadder = false;
    breakAt(ap, wd.WEDGE_REPEAT_CAP);
    await ap.answerWedge(586);
    ok('no rung ran at all', retreats.length === 0 && rails.length === 0);
    ok('...not even the ones that walk', walks.length === 0 && travels.length === 0);
    ok('and it still takes the hold, so the character is not left re-issuing the walk',
       !!ap.wedgeHold);
  }
  {
    // Default and explicit-true are the same thing, or half a fleet would drift.
    const { ap, rails } = keeper({ hp: 20, railWorks: true });
    ap.policy.escapeLadder = true;
    breakAt(ap, wd.WEDGE_REPEAT_CAP);
    await ap.answerWedge(586);
    ok('escape_ladder: true climbs it', rails.length === 1);
  }
  {
    // The two switches are independent: turning the survival one off must not silence this.
    const { ap, rails } = keeper({ hp: 20, railWorks: true });
    ap.policy.backUpWhenWedged = false;
    breakAt(ap, wd.WEDGE_REPEAT_CAP);
    await ap.answerWedge(586);
    ok('back_up_when_wedged does not gate the healthy ladder', rails.length === 1);
  }
}

console.log('\nthe ladder reaches rung 1.5, and falls through when there is no rail');
{
  {
    const { ap, rails, retreats, onwardAsks } = keeper({ hp: 20, railWorks: true });
    breakAt(ap, wd.WEDGE_REPEAT_CAP);
    await ap.answerWedge(586);
    ok('rung 1.5 was tried', rails.length === 1);
    ok('it asked onwardExit(room, destination), in that order',
       onwardAsks[0]?.roomNum === 586 && onwardAsks[0]?.destination === 586);
    ok('and asked for a cached answer only, so the ladder can never run the exits flood',
       onwardAsks[0]?.cachedOnly === true);
    ok('aimed at the onward exit, in (row,col)',
       rails[0].toSquare?.row === 4 && rails[0].toSquare?.col === 9);
    ok('on the same budget as rung 1, never a longer one', rails[0].maxCrumbs === 12);
    ok('and the blind unwind was not also spent', retreats.length === 0);
    // CREDIT LANDS WHERE THE MOVEMENT DID. `worked` compares against the ladder's ENTRY
    // position, so every rung after a successful one inherits its credit -- observed live
    // on the first wedge after deploy-2026-09-06-8, where rung 1 recorded
    // `steps: 0, worked: true` after rung 1.5 had already freed the character. Harmless to
    // the character, fatal to the measurement that says whether rung 1.5 is worth having.
    // Asked of backUpToUnstick directly, because `tried` is its return value.
    const k = keeper({ hp: 20, railWorks: true });
    const rec = await k.ap.backUpToUnstick('a test wedge', { to: 586 });
    ok('the rung that moved the body is the one credited with moving it',
       rec?.tried?.find(x => x.rung === 1.5)?.moved_here === true);
    ok('...and when it rejoins, rung 1 is not run at all rather than run and credited',
       rec?.tried?.some(x => x.rung === 1) === false);
  }
  {
    // No rail to rejoin: the rung declines and rung 1 does the ordinary thing.
    const { ap, rails, retreats } = keeper({ hp: 20, railWorks: false });
    breakAt(ap, wd.WEDGE_REPEAT_CAP);
    await ap.answerWedge(586);
    ok('rung 1.5 was tried and gave nothing', rails.length === 1);
    ok('so rung 1 ran', retreats.length === 1);
    const k2 = keeper({ hp: 20, railWorks: false });
    const rec2 = await k2.ap.backUpToUnstick('a test wedge', { to: 586 });
    ok('a rung that declined is not credited with a move it did not make',
       rec2?.tried?.find(x => x.rung === 1.5)?.moved_here === false);
    ok('...and the fallback that did move is', 
       rec2?.tried?.find(x => x.rung === 1)?.moved_here === true);
  }
  {
    // No onward route: the rung must be skipped, never aimed at the far destination.
    const { ap, rails, retreats } = keeper({ hp: 20, railWorks: true, onward: null });
    breakAt(ap, wd.WEDGE_REPEAT_CAP);
    await ap.answerWedge(586);
    ok('no onward exit means the rung is skipped, not misaimed', rails.length === 0);
    ok('and rung 1 carries the ladder', retreats.length === 1);
  }
  {
    // An older session without the method at all still climbs the ladder.
    const { ap, retreats } = keeper({ hp: 20 });
    breakAt(ap, wd.WEDGE_REPEAT_CAP);
    await ap.answerWedge(586);
    ok('a session with no retreatToRail is unaffected', retreats.length === 1);
  }
}

// ---------------------------------------------------------------------------
// RECORDING A WEDGE AND CANCELLING A WALK ARE TWO DECISIONS.
//
// They were one `if`, and the cost of that was total: raising WATCHDOG_HEALTHY_CANCEL_MS to
// stop the watchdog manufacturing journeys also stopped `wedgeBreak` ever being written, so
// `answerWedge` returned null forever and the escape ladder never ran for a HEALTHY
// character -- the population it exists for. Nothing failed and nothing was logged; the
// ladder was simply never reached. Pinned by source, because the arm needs a live pass and
// this is the property that has to survive the next edit to it.
console.log('\nthe healthy arm records the wedge even when it may not cancel');
{
  // THE BEHAVIOUR IS TESTED IN m59-pulse-test.mjs, which drives this arm in a child process
  // with M59_WATCHDOG_HEALTHY_CANCEL_MS set high and asserts that a break is recorded with
  // nothing cancelled. It lives there because that is where the arm can be RUN.
  //
  // What is left here is the shape of the thing, which that test cannot see. The wall of
  // `AUTOPILOT.includes('<the exact line I just wrote>')` pins that used to be here are
  // gone: they fail on a reflow and they PASS if someone re-fuses the two decisions in
  // different words, which is the only regression worth guarding against.
  ok('the record threshold is shorter than the survival rungs own gate, or the ladder would '
     + 'be reached last instead of first',
     wd.WEDGE_LADDER_MS < wd.WATCHDOG_PINNED_MS);
  ok('`wedgeNotedAt` is declared in freshState, so a host cannot forget it',
     wd.freshState().wedgeNotedAt === null);
  // AND THE SHIPPED HOST IS THE ONE THAT MATTERS. `startWatchdog` used to build its watch as
  // a hand-written literal of fifteen fields, so `wedgeNotedAt` was added to freshState and
  // not to production: the fixture certified a guarantee that did not hold on the only path
  // that runs. Asserting against the real constructor is what makes that visible.
  {
    const ap = Object.create(Autopilot.prototype);
    ap.watchdogTick = () => {};
    ap.startWatchdog();
    try {
      ok('the shipped watch is built from freshState, not a hand-copy of it',
         'wedgeNotedAt' in ap.watch && ap.watch.wedgeNotedAt === null);
      ok('...and carries the pulse ring and the wedge record with it',
         Array.isArray(ap.watch.pulses) && 'wedgeBreak' in ap.watch && 'pinnedSince' in ap.watch);
    } finally { clearInterval(ap.watchTimer); }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
