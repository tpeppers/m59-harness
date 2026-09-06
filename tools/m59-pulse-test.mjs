#!/usr/bin/env node
// IS THE CHARACTER MOVING — the contract test for the position pulse.
//
//   node tools/m59-pulse-test.mjs
//
// Offline, and it drives the REAL function: `pulse()` is imported from
// m59-watchdog.mjs and run against a fake host, because what is under test is a
// DECISION about a sequence of samples, and a sequence is something a fixture can state
// exactly and a live fleet cannot.
//
// It used to lift the method out of m59-autopilot.mjs by brace matching, which worked
// only while the guard lived inside the monolith and broke the moment it moved. Testing
// a real import instead of a string slice is the point of having extracted it.
//
import { pulse, tick, freshState, WATCHDOG_PINNED_MS, WATCHDOG_BLOCKED_MS,
         WATCHDOG_PINNED_SQUARES, WEDGE_LADDER_MS } from './m59-watchdog.mjs';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a keeper mid-walk.
// ---------------------------------------------------------------------------
function keeper({ doing = 'travelling', inert = null, hold = null,
                  room = 587, col = 10, row = 10 } = {}) {
  const self = { col, row, x: col * 64 + 32, y: row * 64 + 32 };
  const notes = [], frames = [];
  return {
    doing, inert, hold, tally: {},
    watch: { pulses: [], lastPulseAt: 0, wedged: null, wedges: 0 },
    s: { client: { self, room: { id: room } } },
    note: (what, detail) => notes.push({ what, detail }),
    recordFrame: why => frames.push(why),
    notes, frames,
    // Move the body, or do not, and take a sample.
    tick(t, { to = null, health = 50 } = {}) {
      if (to) { self.col = to.col; self.row = to.row; self.x = to.col * 64 + 32; }
      return pulse(this, t, { value: health, max: 50 });
    },
  };
}

// ---------------------------------------------------------------------------
console.log('a character that is going somewhere and is not moving gets flagged');
{
  const k = keeper({ doing: 'travelling' });
  ok('one sample is not enough to say anything', k.tick(1000) === null);
  const wedged = k.tick(2000);
  ok('two samples a second apart at the same square is the alert', !!wedged);
  ok('and it says which square', wedged.at.col === 10 && wedged.at.row === 10);
  ok('and what the character was supposed to be doing', wedged.doing === 'travelling');
  ok('it raises a `!` note a person can grep for',
     k.notes.some(n => n.what.startsWith('! NOT MOVING')));
  ok('and writes ONE frame, because a wedge is quiet and the ring is written on damage',
     k.frames.length === 1 && k.frames[0].startsWith('!'));
  ok('it counts the episode', k.watch.wedges === 1 && k.tally.pulse_wedges === 1);

  // ONE EPISODE, NOT ONE PER TICK. At 500ms a five-minute wedge is 600 ticks; six hundred
  // identical notes is the same as no notes.
  for (let t = 3000; t <= 8000; t += 1000) k.tick(t);
  ok('a continuing wedge stays ONE episode', k.watch.wedges === 1);
  ok('and one note', k.notes.filter(n => n.what.startsWith('! NOT MOVING')).length === 1);
  ok('while its duration keeps climbing', k.watch.wedged.for_ms >= 6000,
     `${k.watch.wedged.for_ms}ms`);

  // And it clears when the body moves, so the next wedge is a new event.
  ok('moving clears it', k.tick(9000, { to: { col: 11, row: 10 } }) === null
     && k.watch.wedged === null);
}

// ---------------------------------------------------------------------------
console.log('\nstanding still on purpose is not a stall');
{
  // Each of these is a different reason, and folding them together is how "why was it not
  // flagged" stops being answerable.
  const cases = [
    ['resting', keeper({ doing: 'recovering' })],
    ['fighting', keeper({ doing: 'fighting' })],
    ['trading', keeper({ doing: 'trading' })],
    ['waiting', keeper({ doing: 'waiting' })],
    ['holding a safe spot', keeper({ doing: 'travelling', hold: { col: 10, row: 10 } })],
    ['inert — something else is driving', keeper({ doing: 'travelling', inert: { why: 'errand' } })],
  ];
  for (const [why, k] of cases) {
    k.tick(1000); k.tick(2000); k.tick(3000);
    ok(`${why} is never flagged`, k.watch.wedges === 0 && !k.watch.wedged);
  }
  // HOLDING A WALL IS THE ONE THAT MATTERS MOST. A wall that works and a wedge look
  // identical from outside — perfectly still, for minutes — and they are opposites. The
  // safe wall is the fleet's whole defensive game; flagging it would train everyone to
  // ignore the alert.
  const wall = keeper({ doing: 'travelling', hold: { col: 10, row: 10 } });
  for (let t = 1000; t <= 60000; t += 1000) wall.tick(t);
  ok('a wall held for a full minute raises nothing at all', wall.watch.wedges === 0);
}

// ---------------------------------------------------------------------------
console.log('\nit compares SQUARES, because sliding along a wall is not progress');
{
  // The bounce this exists to catch moves in fine units and goes nowhere: `walkTo` slides,
  // lands off plan, replans into the same wall. Comparing fine coordinates would call
  // that healthy movement, which is exactly the reading that hid the fault for a session.
  const k = keeper({ doing: 'travelling' });
  k.tick(1000);
  k.s.client.self.x += 24;                      // slid a third of a square, same square
  const wedged = k.tick(2000);
  ok('a slide within one square still reads as not moving', !!wedged);

  const moved = keeper({ doing: 'travelling' });
  moved.tick(1000);
  ok('a real change of square does not', moved.tick(2000, { to: { col: 11, row: 10 } }) === null);
}

// ---------------------------------------------------------------------------
console.log('\nand it says whether something is eating the character while it stands there');
{
  // "Stuck" and "stuck and being hit" are the same symptom and completely different
  // urgencies, and the pulse already holds both samples.
  const hurt = keeper({ doing: 'travelling' });
  hurt.tick(1000, { health: 50 });
  const wedged = hurt.tick(2000, { health: 41 });
  ok('a wedge that is taking damage says so', wedged?.taking_hits === true);

  const quiet = keeper({ doing: 'travelling' });
  quiet.tick(1000, { health: 50 });
  ok('a quiet one does not', quiet.tick(2000, { health: 50 })?.taking_hits === false);
}

// ---------------------------------------------------------------------------
console.log('\nit decides nothing, and that is deliberate');
{
  // The handbrake acts on HEALTH and cancels movement. This is an instrument: the whole
  // point is to make a fault debuggable, and an instrument that also acts is one whose
  // false alarms cost characters rather than log lines.
  // Asserted against the REAL function's own source, not a slice of a file: the
  // separation being pinned is that the pulse OBSERVES and the handbrake ACTS, and
  // that has to stay true of the thing that actually runs.
  const method = pulse.toString();
  ok('nothing in the pulse cancels movement',
     !/cancelMovement|cancelledMovement/.test(method));
  ok('nothing in it moves the character',
     !/walkTo|stepFine|leaveVia|travel\(/.test(method));
  ok('and it never throws on a character whose position is unknown', (() => {
    const k = keeper({ doing: 'travelling' });
    k.s.client.self = null;
    try { return k.tick(1000) === null && k.tick(2000) === null; } catch { return false; }
  })());
  // A room change is movement, even to the same square number — rooms have their own grids.
  const zoned = keeper({ doing: 'travelling' });
  zoned.tick(1000);
  zoned.s.client.room.id = 588;
  ok('crossing into another room at the same coordinates is not a stall',
     zoned.tick(2000) === null);
}

// ---------------------------------------------------------------------------
// THE WEDGE THAT IS NOT HURTING ANYBODY — the second arm of the handbrake.
//
// Everything in the handbrake used to be gated on `frac < fleeAt`, so a character wedged
// at FULL health was invisible to the entire guard: the pulse above saw it and said so —
// "Flagged for debugging; nothing was cancelled" — and the handbrake returned one line
// later because health was fine. The only thing that ever broke a wedge was taking enough
// damage to be dying.
//
// Measured on prod 2026-08-27 in the Valley of Ileria: Robin at 40/40 spent one entire
// pass — 46 seconds — alternating between squares 72,65 and 73,64 with two fungus beasts
// in swing range. 8 passes in 30 minutes against a healthy keeper's 77 in 26. They were
// not fighting because the pass that decides to fight never ended.
//
// And the alternation is why `wedged` could not be used for it: that flag wants the SAME
// square twice and two squares alternating clears it on every other sample. These drive
// the REAL tick() against a body that shuffles, which is the case that matters.
console.log('\na wedge at full health is still a wedge');
{
  // A fuller host than `keeper()` above: tick() reads vitals, safety and the pass counter.
  const wedgeHost = ({ health = 50, fleeAt = 0.4, doing = 'travelling',
                       hold = null, inert = null, moving = false } = {}) => {
    const self = { col: 72, row: 65, x: 0, y: 0 };
    const notes = [], cancels = [];
    let step = 0;
    return {
      // passStartedAt must be TRUTHY: the handbrake reads `host.passStartedAt ? ... : 0`,
      // so a pass that began at epoch 0 reads as "not blocked at all".
      doing, inert, hold, tally: {}, passes: 8, passStartedAt: 1, lastFrameAt: 0,
      watch: freshState(),
      s: { live: true,
           cancelMovement: () => { cancels.push(true); return { cancelled: true, interrupted: 'walk' }; },
           client: { self, room: { id: 544 }, state: 'game',
                     vitals: () => ({ health: { value: health, max: 50 } }) } },
      safety: () => ({ fleeAt }),
      note: (what, detail) => notes.push({ what, detail }),
      recordFrame: () => {}, progress: () => {},
      notes, cancels,
      // Two squares, alternating — the shuffle. Or real ground, when `moving`.
      //
      // Alternated on the PULSE cadence (1s), not the tick cadence (500ms): the pulse ring
      // is what pennedIn reads, and flipping twice between samples would land every sample
      // on the same square — a plain wedge, which is the case this section is NOT about.
      // `tick(host)` takes NO clock — it reads Date.now() itself, unlike pulse(host, now).
      // So the clock is stubbed for the run and restored in a finally. Without this every
      // tick lands in the same millisecond, the 1s pulse gate opens once, and the ring
      // never grows past one sample — which looks exactly like the guard not firing.
      run(untilMs) {
        const realNow = Date.now;
        try {
          for (let t = 500; t <= untilMs; t += 500) {
            Date.now = () => t;
            if (moving) { self.col += 2; self.row += 2; }
            else {
              // A CORNER, NOT A SQUARE. This is Robin's actual wedge from prod: columns
              // 71-74 and rows 64-65, drifting around a pocket while getting nowhere. The
              // first version of this guard used `pennedIn` — all samples within ONE square
              // of each other — and this pattern cleared it every few samples, so the timer
              // reset for ever and the breaker never fired once on the live fleet.
              // ROWLF'S POCKET, not Robin's. The first radius (3) was calibrated on a
              // four-column shuffle and missed the very next wedge: Rowlf zoning in Castle
              // Victoria wandered 24,3 · 25,3 · 28,3 · 29,3 · 29,4 — six columns across —
              // and re-anchored every time he crossed three squares, so the timer never
              // matured. The fixture uses the wider pocket for that reason.
              const step = Math.floor(t / 1000) % 5;
              self.col = [24, 25, 28, 29, 29][step];
              self.row = [3, 3, 3, 3, 4][step];
            }
            tick(this);
            step++;
          }
        } finally { Date.now = realNow; }
        return this;
      },
    };
  };

  const shuffling = wedgeHost().run(WATCHDOG_PINNED_MS + 4_000);
  ok('a full-health body drifting around a CORNER is eventually broken out of',
     shuffling.cancels.length === 1, `${shuffling.cancels.length} cancels`);
  // The regression that shipped and did nothing: measuring stillness instead of ground.
  ok('and it is caught even though it never sits on the same square twice',
     !shuffling.watch.wedged,
     'the same-square detector should never have latched on this pattern');
  const note = shuffling.notes.find(n => n.what.startsWith('WATCHDOG — broke a wedge'));
  ok('and it says so in a note a person can grep for', !!note);
  ok('which reports how long it covered no ground', (note?.detail?.penned_for_s ?? 0) >= 20,
     `${note?.detail?.penned_for_s}s`);
  ok('and counts it separately from the emergency arm',
     shuffling.tally.watchdog_pinned_interrupts === 1 &&
     !shuffling.tally.watchdog_interrupts);
  ok('it fires ONCE per pass, not once per tick', shuffling.cancels.length === 1);

  // ---------------------------------------------------------------------------
  // THE ARM RECORDS THE WEDGE EVEN WHEN IT IS NOT ALLOWED TO CANCEL.
  //
  // This is the property the record/cancel split exists for, and it is executed rather than
  // grepped. What it defends, exactly: `wedgeBreak` is the only thing an escape ladder is
  // reached from, this arm is the only thing that writes it, and it used to write it below
  // `if (pinnedFor < WATCHDOG_HEALTHY_CANCEL_MS) return;`. So raising that threshold — the
  // supported way to stop the watchdog manufacturing journeys, set in
  // substrate/watchdog.local.json and live on prod since deploy-2026-09-06-7 — also stopped
  // the ladder ever running for a HEALTHY character. Silently, nothing logged, every suite
  // green.
  //
  // RUN IN A CHILD PROCESS, because the threshold is a module-level const resolved at import
  // from `M59_*` env or watchdog.local.json. A fixture flag would test a fixture; this tests
  // the override an operator actually uses, end to end, including that the env name is what
  // `num()` looks for. A source-level check could not catch the regression returning at all:
  // re-fusing the two decisions in different words passes any grep.
  {
    // `.href`, not a filesystem path: the child's ESM loader rejects a bare `C:\...`.
    const probe = new URL('./m59-watchdog.mjs', import.meta.url).href;
    const script = `
      import { tick, freshState } from ${JSON.stringify(probe)};
      const self = { col: 24, row: 3, x: 0, y: 0 };
      const notes = [], cancels = [];
      const host = {
        doing: 'travelling', inert: null, hold: null, tally: {}, passes: 8,
        passStartedAt: 1, lastFrameAt: 0, watch: freshState(),
        s: { live: true,
             cancelMovement: () => { cancels.push(true); return { cancelled: true }; },
             client: { self, room: { id: 544 }, state: 'game',
                       vitals: () => ({ health: { value: 50, max: 50 } }) } },
        safety: () => ({ fleeAt: 0.4 }),
        note: (what, detail) => notes.push({ what, detail }),
        recordFrame: () => {}, progress: () => {},
      };
      const realNow = Date.now;
      for (let t = 500; t <= Number(process.env.PROBE_MS); t += 500) {
        Date.now = () => t;
        const step = Math.floor(t / 1000) % 5;
        self.col = [24, 25, 28, 29, 29][step];
        self.row = [3, 3, 3, 3, 4][step];
        tick(host);
      }
      Date.now = realNow;
      process.stdout.write(JSON.stringify({
        cancels: cancels.length, repeats: host.watch.wedgeBreak?.repeats ?? 0,
        pinnedSince: host.watch.pinnedSince, tally: host.tally,
        recorded: notes.some(n => n.what === 'WATCHDOG \u2014 recorded a wedge that was not hurting anybody'),
      }));
    `;
    // The duration goes by env too: with `--eval`, the first user argument lands at
    // argv[1], not argv[2], and reading the wrong slot silently ran ZERO ticks — a probe
    // that asserts nothing while reporting failures that look like the code.
    const runArm = (ms, env) => JSON.parse(execFileSync(
      process.execPath, ['--input-type=module', '--eval', script],
      { env: { ...process.env, ...env, PROBE_MS: String(ms) }, encoding: 'utf8' }));

    const off = runArm(WEDGE_LADDER_MS + 4_000, { M59_WATCHDOG_HEALTHY_CANCEL_MS: '2147483647' });
    ok('with cancels switched off, nothing is cancelled', off.cancels === 0);
    ok('...but the wedge is still RECORDED, which is what a ladder is reached from',
       off.repeats >= 1);
    ok('...it is counted, so an operator can see the arm is alive',
       (off.tally.watchdog_wedges_recorded ?? 0) >= 1);
    ok('...the interrupt counter stays honest at zero',
       !off.tally.watchdog_pinned_interrupts);
    ok('...the note says it recorded rather than broke', off.recorded === true);
    ok('...and `pinnedSince` is NOT cleared, so the survival rungs still reach their own ' +
       'threshold', off.pinnedSince !== null);

    // Paced, not per tick: WEDGE_REPEAT_CAP records is what makes a ladder give up, so an
    // unpaced arm would reach the cap in under two seconds of ordinary slow walking.
    const paced = runArm(WEDGE_LADDER_MS * 3, { M59_WATCHDOG_HEALTHY_CANCEL_MS: '2147483647' });
    ok('records are paced one per WEDGE_LADDER_MS, never one per tick',
       paced.repeats <= 3, `${paced.repeats} repeats`);

    // And with cancels on — the shipped default — the arm still does both.
    const on = runArm(WATCHDOG_PINNED_MS + 4_000, {});
    ok('with cancels on the arm still cancels', on.cancels >= 1);
    ok('...and records in the same breath', on.repeats >= 1);
    // The cancel's bookkeeping, not the anchor's final value: clearing `pinnedSince` re-arms
    // it the moment the body shuffles again, so reading it after the run measures the
    // fixture's last tick rather than whether a cancel happened.
    ok('...doing the interrupt bookkeeping a cancel is supposed to do',
       on.tally.watchdog_pinned_interrupts >= 1);
  }

  // NOT BEFORE ITS TIME. The 3s emergency threshold is for a character that is bleeding;
  // applying it here would cancel every legitimate slow walk in the game.
  const early = wedgeHost().run(WATCHDOG_BLOCKED_MS + 2_000);
  ok('a few seconds of shuffling is NOT enough — that is an ordinary slow walk',
     early.cancels.length === 0);

  // The three excuses, each for its own reason.
  ok('holding a safe wall is standing still on purpose and is never broken',
     wedgeHost({ hold: { at: {} } }).run(WATCHDOG_PINNED_MS + 4_000).cancels.length === 0);
  ok('an errand that owns the character is not ours to cancel',
     wedgeHost({ inert: { why: 'an errand' } }).run(WATCHDOG_PINNED_MS + 4_000).cancels.length === 0);
  ok('and a character that is not going anywhere cannot be wedged on the way there',
     wedgeHost({ doing: 'fighting' }).run(WATCHDOG_PINNED_MS + 4_000).cancels.length === 0);
  ok('nor is a body that is actually covering ground',
     wedgeHost({ moving: true }).run(WATCHDOG_PINNED_MS + 4_000).cancels.length === 0);

  // THE RADIUS MUST COVER THE POCKET, NOT THE STEP. A wedge that out-wanders the anchor
  // radius re-anchors for ever and is never flagged, which is exactly how radius 3 missed
  // Rowlf after being calibrated on Robin. Pinned explicitly so nobody tightens it back.
  ok('the anchor radius is wide enough for a real pocket, not just a two-square shuffle',
     WATCHDOG_PINNED_SQUARES >= 6, `radius ${WATCHDOG_PINNED_SQUARES}`);
  // And still far below what a real journey covers: ~5 squares/second means a genuine
  // walk leaves any of these boxes within a couple of seconds.
  ok('but still far tighter than genuine travel over the same window',
     WATCHDOG_PINNED_SQUARES < (WATCHDOG_PINNED_MS / 1000) * 5,
     `${WATCHDOG_PINNED_SQUARES} squares vs ~${(WATCHDOG_PINNED_MS / 1000) * 5} travelled`);

  // AND THE EMERGENCY ARM IS UNCHANGED. A hurt character is still interrupted at 3s by the
  // original path, not made to wait twenty for the new one.
  const hurt = wedgeHost({ health: 10 }).run(WATCHDOG_BLOCKED_MS + 1_500);
  ok('a character below the flee line is still interrupted at the OLD threshold',
     hurt.cancels.length === 1 && hurt.tally.watchdog_interrupts === 1);
  ok('and it is the blind-walk note, not the new one',
     hurt.notes.some(n => n.what.startsWith('WATCHDOG — pulled the character out')) &&
     !hurt.notes.some(n => n.what.startsWith('WATCHDOG — broke a wedge')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
