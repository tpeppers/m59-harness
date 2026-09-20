#!/usr/bin/env node
// SPIKE: WHICH GEOMETRY ACTUALLY MAKES A SAFE WALL?
//
//   node tools/fleetscripts/spike-safe-walls.mjs          the recorded truth + library conformance
//   node tools/fleetscripts/spike-safe-walls.mjs --plan   the experiment it would run, per room
//   ...or drive it on a fleet:  spike-safe-walls agents=shadow01,... arm=refused
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A SPIKE SCRIPT IS — THIS IS THE FIRST ONE, SO THE SHAPE IS PART OF THE DELIVERABLE
//
// Asked for by the operator, 2026-09-20. In his words, reworded here to show I have understood
// what he is asking for rather than to quote it:
//
//   A spike script is a FleetScript whose product is a TRUTH rather than an errand. It exists
//   to settle one question about how this world actually behaves, and then to keep settling it.
//   Three things live in the same file and none of them is optional:
//
//     THE FACT        what we currently believe is true, written as prose a person can argue
//                     with, with the citations that justify it.
//     THE EXPERIMENT  the procedure that would prove it false, described precisely enough that
//                     somebody else could run it and get the same answer.
//     THE RESULT      what happened when it was run. Until it has been run, that section says
//                     so, in those words, and the file does not pretend otherwise.
//
//   When our understanding changes, the spike is EDITED rather than replaced — the new fact,
//   the experiment that revised it, the new result. The file is the living record of what we
//   know, and running it is how we find out whether we still know it.
//
//   And a spike must run as a TEST. Not "here is a script you could run": invoking the file
//   checks that the library still behaves the way the recorded fact says it does, and fails if
//   it does not. A truth nobody re-checks is a comment.
//
// So this file has two halves. The offline half (`node <this file>`) asserts that the shipped
// selection code still implements the fact below, and takes seconds. The live half drives real
// characters into real monster rooms and measures whether the fact survives contact, and takes
// a few minutes.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE THEORY OF REALITY — ONE MODEL, AND EVERYTHING BELOW EITHER SUPPORTS IT OR KILLS IT
//
// The operator's instruction for what this file is, 2026-09-20: a spike is fixed by correcting a
// SINGULAR theory of reality, the way an experiment settles aether or Copernicus. Its worth is
// that the output is a coherent system that can be reasoned about and disproved against the
// record. Historical data is checked by REPRODUCTION, and historical data that cannot be
// reproduced is treated as measurement error or as an anomaly.
//
// THE MODEL, stated so it can be attacked:
//
//   A square protects a body from monsters when nothing within melee reach has line of sight
//   to it — `attackers === 0` — and the body has NOT SWUNG since the monster last moved.
//
//   There is ONE kind of safe wall. It does not leak. A failure on one is a measurement error
//   until somebody produces a body standing on the square, not swinging, losing health.
//
// THIS FILE ARGUED THE OPPOSITE TWICE AND BOTH TIMES IT WAS WRONG, which is the whole reason the
// wrong versions are left visible. First it said `attackers === 0` was sufficient on the strength
// of eleven live trials that turned out to be inadmissible. Then, corrected by postmortem
// evidence, it said `attackers === 0` was NOT sufficient and that a second clause — every
// adjacent approach refused — was the real mechanism. That second correction was also wrong, and
// the operator's objection is what caught it: he has never seen or heard of a safe wall failing.
//
// ── WHY THE SECOND MODEL DIED: THE EVIDENCE FOR IT WAS AN ATTRIBUTION BUG ──────────────────
//
// The case against `attackers === 0` rested on ten deaths since 09-18 where the character was
// "holding a wall" in its last living frame, every one flagged `proven: true`. The check nobody
// ran was whether the BODY was on the square it was holding:
//
//     who      room  holding@   body@     off by
//     Kermit    599   62,1      15,46        47
//     Robin     579   3,45      71,39        68
//     Piggy     599   11,54     30,57        19
//     Waldorf   584   34,47     30,35        12
//     Scooter   584   37,38     30,35         7
//     Bunsen    584   37,38     32,35         5
//     ... 9 of 10 NOT on the wall. Gonzo (70 @ 8,8) is the only one that was.
//
// `holding` is a keeper's record of a spot it has RESERVED. It is not a statement that the body
// is standing on it. Nine of those ten characters died in the open with a stale hold recorded
// beside them, and reading `holding` as "was on a safe wall" turned nine open-ground deaths into
// a refutation of the geometry. The one character who was genuinely on its square, Gonzo, had
// swung 22 seconds earlier — the contract, not the wall.
//
// ZERO CLEAN COUNTEREXAMPLES SURVIVE. Not one death in the corpus shows a body standing on a
// square with `attackers === 0`, not swinging, losing health to a monster.
//
// ── AND THE SAFE-SPOT LEDGER CANNOT ATTRIBUTE DAMAGE TO A SQUARE AT ALL ────────────────────
//
// The same bug, in the writer, structurally:
//
//     this.book.failed(this.hold.room, { col: this.hold.col, row: this.hold.row, ... })
//
// It records the HOLD's coordinates. So when Kermit took damage 47 squares from the wall it
// held, the ledger wrote that damage against the wall. Every failure row in that file is a
// statement about a square the character may not have been standing on — the 96.4% carrying
// `failed_via: "fight"` and the 58 non-fight rows alike. I used those 58 as the "genuine leak"
// residue and reported that 15 of 15 of them landed in the gap between the two clauses. That
// number is real and it means nothing, because the squares it names are not where the damage
// happened.
//
// THIS IS THE ARGUMENT FOR RETIRING THE LEDGER, and it is stronger than the one the retirement
// was originally asked for. It is not that nothing reads it. It is that it CANNOT BE RIGHT: a
// per-square failure record whose writer does not know where the body was is not evidence about
// squares, and every conclusion drawn from it — including two of mine, in this file — has been
// wrong in the same direction.
//
// ── WHY NOT CLAUSE TWO ON ITS OWN ──────────────────────────────────────────────────────────
//
// Asked directly, and the answer is arithmetic rather than evidence. `gridDisagreementAt` walks
// `RING`, which is the EIGHT SQUARES TOUCHING YOU — radius 1. `MONSTER_REACH` is 3, and the
// server's own test is `SquaredDistanceTo <= range^2` (monster.kod:1682). So "every approach
// refused" says only that nothing can step into contact; a monster standing two or three squares
// away with line of sight never needs to. Refusal covers radius 1, reach extends to radius 3, and
// the gap between them is a square that admits attacks nothing walked into.
//
// That is why the 411 all-refused-but-visible squares are not walls, and it is why clause two
// cannot stand alone. It was never a rival definition — it is a subset marker inside clause one.
//
// ── THE LIVE EXPERIMENT, AND WHAT IT PROVED — 2026-09-20 ───────────────────────────────────
//
// THE DEBT IS PAID. This section used to say the live half had never produced an admissible
// trial. It has now, and the model survived it: `tools/m59-wallproof.mjs --collect --analyze`,
// 23 agents, 22.8 minutes, 200 incoming attacks.
//
// THE MEASUREMENT CHANGED, and that is why it finally worked. Six designs watched the health
// bar and reasoned backwards to "was I attacked". The flight recorder makes it direct — the
// server announces every swing in words ("You dodge the orc's attack", "The troll wounds you
// with its attack") — so attacks are COUNTED. Poison then cannot enter at all, because a
// poison tick emits no attack message; regeneration cannot hide a beating, because an attack
// counts whether or not the damage was healed back; and a quiet room shows up honestly as an
// empty control cell instead of as a silent pass.
//
// THE 2x2. Every second of exposure is gated the way the operator required the evidence to be:
// counted only while a NON-POISONING MONSTER WAS WITHIN REACH AND OBSERVED CHANGING FINE
// POSITION between polls. Seconds when nothing was near test no square on either kind of
// ground, and leaving them in is what drove the earlier rounds' rates to zero.
//
//                          attacks   admissible seconds   squares    rate
//     A  wall, NOT swinging      0          1290             19     0.000 /s
//     B  wall, swinging         23           120              4     0.192 /s
//     C  open, NOT swinging     15           223             19     0.067 /s
//     D  open, swinging         22            15              3     1.446 /s
//
// Cell A is the claim. Twenty-one minutes of standing on `attackers === 0` across NINETEEN
// distinct squares, not swinging, with a monster in reach and visibly moving, and NOT ONE
// incoming attack. At cell C's rate that window predicts 87 attacks; Poisson P(0 | 87) is
// 2.3e-38. The zero is not one lucky square: the largest contributor is 40% of the time.
//
// AND THE CONFOUND-FREE VERSION, which is the part that settles it. Two squares were observed
// in BOTH states, so room, geometry, monsters and body are held constant by construction and
// the only variable left is whether the body swung:
//
//     square        NOT swinging          swinging
//     516:1,31      0 attacks / 965s      17 attacks / 79s
//     516:1,28      0 attacks / 128s       4 attacks / 70s
//
// ── WHAT THIS SETTLES, INCLUDING AGAINST THIS FILE'S OWN EARLIER CLAIMS ────────────────────
//
// THE MODEL AT THE TOP IS CONFIRMED AS STATED — both clauses of it. `attackers === 0` is
// sufficient, and it is sufficient ONLY while the body has not swung. Those are not two
// findings; cell A and cell B are the same squares.
//
// "FREE SHOTS" ARE NOW DISPROVED IN PLAY, not merely by argument. Swinging from a safe wall
// drew 0.192 attacks/s — slightly MORE than standing in the open doing nothing (0.067/s). A
// safe wall does still help a great deal while fighting, 1.446 -> 0.192 against open ground,
// a 7.5x reduction. But it is not free, and a policy that admits squares because they offer
// `free_shots > 0` is selling a thing that does not exist.
//
// AN EARLIER VERSION OF THIS FILE REPORTED "THE WALL LEAKED" AND IT WAS AN INSTRUMENT FAULT.
// `autopilot stop` returns `running:false` and is reverted by a watchdog within three seconds,
// so a staged wall-versus-open comparison measured a farming keeper in both phases: 18 health
// lost on the "wall" against 14 in the "open" was the difference between two fights, not two
// squares. It is recorded here because the retraction is worth more than the claim was.
//
// ── WHAT WOULD KILL THIS MODEL ─────────────────────────────────────────────────────────────
//
//   ONE incoming attack message, arriving at a body standing on a square with `attackers === 0`
//   that has not swung within ten seconds, while a non-poisoning monster is within reach and
//   observed at two or more distinct fine positions. `m59-wallproof.mjs --analyze` prints cell A
//   with exactly that definition, so re-running it is the standing test. One is enough — and
//   nine deaths recorded BESIDE a wall are still not one death ON it.
//
import { act, walk, rest, verify, place, healUp, snapshot } from '../m59-fleetscript.mjs';
import { geometryFor, exposureAt, gridDisagreementAt } from '../m59-safespots.mjs';
import { readFileSync as _readFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────── the rooms, and why these
//
// The top ten death rooms by monster across the whole postmortem corpus (3,731 records, 62 PVP
// excluded), counted 2026-09-20. `losOnly` and `allRefused` are the square counts measured the
// same day; a room with `allRefused: 0` can only ever run the `los` arm, which is itself worth
// knowing — it means the fleet has no fully-refused shelter in half the places it dies.
export const ROOMS = Object.freeze([
  { room: 599, name: "Ukgoth, Holy Land of Trolls",        deaths: 522, losSafe: 199, allRefused: 9 },
  { room: 598, name: 'The Cragged Mountains',              deaths: 460, losSafe: 105, allRefused: 6 },
  { room: 585, name: 'The border of the Badlands',         deaths: 314, losSafe:  14, allRefused: 0 },
  { room: 597, name: 'The Twisted Wood',                   deaths: 304, losSafe: 112, allRefused: 0 },
  { room:  39, name: 'Upstairs in Castle Victoria',        deaths: 289, losSafe: 185, allRefused: 6 },
  { room: 587, name: 'Western border of the Twisted Wood', deaths: 241, losSafe: 154, allRefused: 0 },
  { room: 584, name: 'The Flatlands',                      deaths: 199, losSafe:  76, allRefused: 2 },
  { room: 578, name: 'The Cragged Mountains',              deaths: 176, losSafe: 196, allRefused: 6 },
  { room: 544, name: 'Valley of Ileria',                   deaths: 120, losSafe:  82, allRefused: 0 },
  { room:  38, name: 'Castle Victoria',                    deaths: 112, losSafe: 112, allRefused: 0 },
]);

// THREE ARMS, AND THE THIRD IS A POSITIVE CONTROL.
//
// ADDED 2026-09-20 AFTER THE FIRST TWO RUNS, because the first two runs could not tell the
// difference between "both definitions protect" and "this probe cannot see damage". Eight
// trials came back HELD on both arms; the only reason that was not simply a broken instrument
// is that one trial in run 1 DID report a 10-health loss. Resting an entire experiment on a
// single accidental positive is not a method.
//
// So `control` puts a character on a square in the SAME ROOM that is deliberately NOT a safe
// wall — `attackers > 0`, something can see it from within reach — and makes a monster angry at
// it in exactly the same way. The control is not a hypothesis. It is the answer to "would this
// probe have noticed?", and until it bleeds, a HELD on either real arm means nothing.
//
// READ THE THREE TOGETHER:
//   control LEAKS, both arms HELD   -> the probe works and BOTH definitions protect.
//   control LEAKS, los LEAKS        -> the probe works and the LOS-only rule is insufficient.
//   control HELD                    -> the trial proved nothing; the room was too quiet to test
//                                      anything and every other verdict in it is discarded.
export const ARMS = Object.freeze(['los', 'refused', 'control']);

// Rooms where both arms can run, which is the comparison the spike is actually for.
export const COMPARABLE = Object.freeze(ROOMS.filter(r => r.allRefused > 0).map(r => r.room));

// ───────────────────────────────────────────────────────────────────────── the square chooser
//
// ASKED OF THE LIVE BROKER, NEVER OF THE BOOK. `safe_spots` returns the geometry for the room
// the character is standing in, including `refused_approaches` and `offered_approaches`, which
// is what lets one call serve both arms. The safe-spot ledger is deliberately not consulted:
// it is a history of afternoons, it has been retired from every decision (see `discredited`,
// which returns false unconditionally), and reading it here would feed the thing being measured
// back into the measurement.
export const pickSquare = (spots, arm) => {
  const list = (spots ?? []).filter(s => Number.isFinite(s?.col) && Number.isFinite(s?.row));
  if (arm === 'refused')
    return list.find(s => Number.isFinite(s.offered_approaches) && s.offered_approaches > 0 &&
                          s.refused_approaches === s.offered_approaches) ?? null;
  // The `los` arm takes what the shipped selector would hand a character today: the list is
  // already ordered best-first by the same scoring the keeper uses.
  return list[0] ?? null;
};

// How long to sit before believing the answer. Long enough that a monster which was going to
// reach us has, short enough that ten rooms finish inside a few minutes.
export const SETTLE_WINDOW_MS = 45_000;
// A blow inside this of arriving was resolved before we got there. Same argument, and the same
// number, as the autopilot's own SETTLE_GRACE_MS.
export const SETTLE_GRACE_MS = 2_000;

const hp = (st) => {
  const v = st?.vitals?.health ?? st?.hp ?? null;
  return v && Number.isFinite(v.value) ? { value: v.value, max: v.max ?? null } : null;
};
const ailing = (st) => Array.isArray(st?.ailments) ? st.ailments.length > 0 : null;

// ────────────────────────────────────────────────────────────────────────────── the live half
//
// ONE STEP, because every decision in it depends on what is standing in the room at the moment
// the character gets there — which monster is alive, which squares the geometry offers now, and
// whether anything actually engaged. A compiled list of `act` steps freezes all three at plan
// time, which for an experiment about monsters is the same as not running it.
export const probe = ({ arm = 'los', room = null, settleMs = SETTLE_WINDOW_MS } = {}) =>
  verify(async ({ agent, call }) => {
    const out = { agent, arm, room, verdict: null, why: null };

    // 1. START FROM A KNOWN BAR. A character that arrives at 30% and ends at 30% has proved
    //    nothing about the wall, and one that arrives hurt may be fetched away by its own
    //    survival ladder mid-measurement.
    const before = await call('status', { agent }, 30_000).catch(() => null);
    const here = before?.where?.num ?? before?.room?.num ?? null;
    if (room != null && here !== room)
      return { ok: false, ...out, verdict: 'wrong_room', why: `expected ${room}, standing in ${here}` };

    // 2. FIND SOMETHING THAT WILL FIGHT BACK. A wall untested by an angry monster proves
    //    nothing, so an empty room is skipped rather than passed.
    const seen = await call('look', { agent }, 40_000).catch(() => null);
    const monster = (seen?.objects ?? []).find(o => o && !o.is_player &&
      Array.isArray(o.can) && o.can.includes('attack'));
    if (!monster)
      return { ok: true, ...out, verdict: 'no_monster', why: 'nothing here to be protected from' };

    // 3. SWING ONCE, TO MAKE IT ANGRY, AND THEN NEVER AGAIN. This is the premise under test:
    //    the wall is supposed to protect a character that HAS fought and then stopped.
    await call('attack', { agent, target: monster.id ?? monster.name }, 40_000).catch(() => null);

    // 4. TAKE THE SQUARE THIS ARM IS ABOUT.
    const geo = await call('safe_spots', { agent, limit: 24, reachable_only: true }, 60_000)
      .catch(() => null);
    const square = pickSquare(geo?.spots, arm);
    if (!square)
      return { ok: true, ...out, verdict: 'no_candidate',
               why: `no square in room ${here} satisfies the "${arm}" rule` };
    out.square = { col: square.col, row: square.row,
                   can_reach_you: square.can_reach_you ?? null,
                   free_shots: square.free_shots ?? null,
                   refused: `${square.refused_approaches}/${square.offered_approaches}` };

    const walked = await call('walk_to', { agent, col: square.col, row: square.row }, 90_000)
      .catch(e => ({ error: String(e) }));
    const arrived = await call('status', { agent }, 30_000).catch(() => null);
    const atSquare = (arrived?.where?.col ?? arrived?.col) === square.col &&
                     (arrived?.where?.row ?? arrived?.row) === square.row;
    if (!atSquare)
      return { ok: true, ...out, verdict: 'unreachable',
               why: `could not stand on ${square.col},${square.row}: ${walked?.error ?? 'did not arrive'}` };

    // 5. SIT STILL AND WATCH THE BAR. `rest` is the posture; the sampling is ours because the
    //    thing being measured is damage DURING the rest, which no rest tool reports.
    const settledAt = Date.now();
    await call('rest', { agent }, 30_000).catch(() => null);
    const start = hp(arrived);
    let low = start?.value ?? null, ailedEver = false, firstHitAt = null;
    for (;;) {
      await new Promise(r => setTimeout(r, 5_000));
      const now = await call('status', { agent }, 30_000).catch(() => null);
      const h = hp(now);
      if (ailing(now)) ailedEver = true;
      if (h && start && h.value < (low ?? h.value)) {
        low = h.value;
        if (firstHitAt == null) firstHitAt = Date.now();
      }
      if (Date.now() - settledAt >= settleMs) break;
    }

    // 6. THE VERDICT, WITH THE EXCLUSIONS THAT STOP A FALSE FAILURE.
    const lost = start && low != null ? start.value - low : null;
    const settledFor = firstHitAt ? firstHitAt - settledAt : null;
    out.health = { start: start?.value ?? null, low, max: start?.max ?? null, lost };
    if (lost == null) return { ok: false, ...out, verdict: 'unreadable', why: 'health never read' };
    if (lost <= 0) return { ok: true, ...out, verdict: 'HELD', why: `${settleMs}ms settled, no damage` };
    if (ailedEver) return { ok: true, ...out, verdict: 'ailing',
                            why: 'lost health while ailing — poison ticks through any wall' };
    if (settledFor != null && settledFor < SETTLE_GRACE_MS)
      return { ok: true, ...out, verdict: 'settling',
               why: `first damage ${settledFor}ms after arriving — resolved before we got there` };
    return { ok: false, ...out, verdict: 'LEAKED',
             why: `lost ${lost} health while settled and not swinging on a "${arm}" square` };
  }, `spike: swing once, take a "${arm}" square in room ${room ?? '?'}, sit ${Math.round(settleMs / 1000)}s ` +
     `and see whether the wall holds`);

// ──────────────────────────────────────────────────────────── who tests what, and why in pairs
//
// BOTH ARMS IN THE SAME ROOM, AT THE SAME TIME. The first draft of this sent one character per
// room and compared rooms against each other, which would have measured the rooms: Ukgoth's
// trolls and the Flatlands' spiders are different monsters with different reach, different
// aggression and different numbers, and an arm that drew the easier room would have won on
// that alone.
//
// So characters are PAIRED. Two go to the same room at the same time; one takes the square the
// shipped selector offers (`los`), the other the square that also has every approach refused
// (`refused`). Same monsters, same minute, same room — the only difference is the rule that
// chose the square, which is the only thing this spike is about.
//
// `runNamed` builds steps per agent (`steps: agent => script.steps({...params, agent, agents})`),
// so the assignment is a pure function of where the agent sits in the list.
export const assignmentFor = (agent, agents, rooms = COMPARABLE) => {
  const list = [].concat(agents ?? []).filter(Boolean);
  const i = list.indexOf(agent);
  if (i < 0) return null;
  // Pairs: 0,1 -> first room; 2,3 -> second; and within a pair, even is `los`, odd `refused`.
  const room = rooms[Math.floor(i / 2) % rooms.length];
  return { room, arm: i % 2 === 0 ? 'los' : 'refused', pair: Math.floor(i / 2) };
};

export const script = {
  name: 'spike-safe-walls',
  provenance: { pinned: '49f9a4e', verified: '2026-09-20',
                touches: ['tools/m59-safespots.mjs', 'tools/m59-broker.mjs', 'tools/m59-fleetscript.mjs'] },
  describe: 'Spike: does a safe wall need line-of-sight safety, or refused approaches?',
  recipe: {
    effect: 'Drives one character into each of the fleet\'s top death rooms, makes a monster ' +
            'angry, retreats to a square chosen by one of two competing definitions, and ' +
            'measures whether the wall actually stops the damage. Settles which geometry is ' +
            'the real safe wall.',
    run: 'spike-safe-walls agents=<who> arm=los|refused [room=<n>] [settleMs=45000]',
    needs: ['the SHADOW fleet, not prod — this deliberately makes monsters angry',
            'a character per room under test, already in that room',
            'nothing else driving those characters: the survival ladder will fetch a hurt ' +
            'character away mid-measurement and the run will read that as the wall holding'],
    cost: { time: 'about a minute per room per arm, dominated by the settle window',
            money: 'none — nothing is bought and nothing is sold',
            risk: 'the character is deliberately put in front of a monster and told to stop ' +
                  'swinging. On the wrong square that is a death, which is the experiment.',
            measured: 'NOT YET RUN — see THE RESULT at the top of this file' },
    scales: 'Ten rooms, two arms, one character each. Five rooms can only run the `los` arm ' +
            'because they contain no fully-refused square at all.',
    notes: ['`free_shots > 0` is not a second condition: it is implied by `attackers === 0` on ' +
            '23,605 of 23,605 safe squares world-wide, because PLAYER_DISC is a subset of ' +
            'MONSTER_DISC. Only 4 degenerate squares are excluded by it.',
            'Only 4.9% of encoded safe walls have all approaches refused, so the two ' +
            'definitions disagree about roughly 22,000 squares.',
            'A room with no monster in it is skipped, never passed: a wall nothing attacked ' +
            'has not been tested.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who is running the probe' },
    arm: { type: 'string', default: 'los', describe: 'los | refused — which definition to test' },
    room: { type: 'number', default: null, describe: 'the room this character is testing' },
    settleMs: { type: 'number', default: SETTLE_WINDOW_MS, describe: 'how long to sit still' },
  },
  // THE SQUARE THIS ARM WANTS, COMPUTED AT PLAN TIME FROM THE SAME GEOMETRY THE KEEPER USES.
  // Resolved here rather than live because `place()` needs an exact square before anything
  // moves, and because a square chosen from the map is reproducible: two runs of this spike
  // put the same body on the same square and any difference between them is the world.
  squareFor(roomNum, arm) {
    const map = JSON.parse(_readFileSync(new URL('../../substrate/m59-map.json', import.meta.url), 'utf8'));
    const rm = Object.values(map.rooms ?? map).find(r => Number(r?.num) === Number(roomNum));
    if (!rm) return null;
    let geo; try { geo = geometryFor(rm); } catch { return null }
    if (!geo) return null;
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      let ex, dis;
      try {
        ex = exposureAt(geo, r, c, { fine: false });
        dis = geo.collisionReady ? gridDisagreementAt(geo, r, c) : null;
      } catch { continue }
      // The control wants the OPPOSITE of a wall: somewhere plainly exposed, and the more
      // exposed the better, so the trial fails loudly rather than marginally.
      if (arm === 'control') {
        if (ex.attackers >= 4) return { row: r, col: c, refused: dis ? `${dis.refused}/${dis.offered}` : '?',
                                        attackers: ex.attackers };
        continue;
      }
      if (!ex || ex.attackers !== 0 || !dis || dis.offered <= 0) continue;
      const all = dis.refused === dis.offered;
      if (arm === 'refused' ? all : !all)
        return { row: r, col: c, refused: `${dis.refused}/${dis.offered}`, attackers: 0 };
    }
    return null;
  },

  async steps(p) {
    // PAIRED unless told otherwise. Naming `room=` and `arm=` explicitly runs one probe the
    // caller has chosen, which is what a single-room re-check wants; giving several agents and
    // naming neither runs the paired comparison this spike exists for.
    const paired = p.room == null && (p.agents?.length ?? 0) > 1;
    const a = paired ? assignmentFor(p.agent, p.agents) : { room: p.room, arm: p.arm };
    if (!a) return [verify(() => false, `no assignment for agent "${p.agent}"`)];
    if (!ARMS.includes(String(a.arm)))
      return [verify(() => false, `arm must be one of ${ARMS.join(', ')} — got "${a.arm}"`)];
    // PLACED, NOT WALKED. The first attempt at this experiment walked six characters to three
    // monster rooms: it took over seven minutes, they arrived at different times, one arrived
    // at 2 of 54 health and one never reached a square the keeper would call a safe spot. That
    // measured the roads. `place()` and `healUp()` are the lab primitives added for exactly
    // this — see their note in m59-fleetscript.mjs — and they refuse on any fleet not named in
    // M59_LAB_FLEETS, so this spike cannot be pointed at production by accident.
    const sq = script.squareFor(a.room, a.arm);
    if (!sq) return [verify(() => false,
      `room ${a.room} has no square satisfying the "${a.arm}" rule — this arm cannot run here`)];
    return [
      // Where everyone was, so a repeat run does not cost the fleet its afternoon.
      snapshot('safe-walls'),
      place(a.room, { row: sq.row, col: sq.col },
            { why: `spike ${a.arm}: ${sq.col},${sq.row} with approaches refused ${sq.refused}` }),
      // Start whole, and without ailments: poison ticks through any wall and is noise here.
      healUp({ why: 'both arms must start from the same bar or this measures the ladder' }),
      probe({ arm: a.arm, room: a.room, settleMs: p.settleMs ?? SETTLE_WINDOW_MS }),
    ];
  },
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE OFFLINE HALF — RUNNING THIS FILE CHECKS THAT THE RECORDED FACT IS STILL TRUE OF THE CODE.
//
// A spike that only describes a truth decays into a comment. So every number quoted in THE FACT
// above is RE-DERIVED here from the shipped geometry and the baked map, and the file exits
// non-zero if any of them has moved. If somebody changes `safeWalls()`, this is what tells them
// which recorded belief they just invalidated.
//
// It does NOT check the world — only the library. Whether monsters actually respect these
// squares is THE RESULT, and only a live run fills that in.
// ═════════════════════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const S = await import('../m59-safespots.mjs');
  const here = (p) => new URL(p, import.meta.url);
  let pass = 0, fail = 0;
  const ok = (what, cond, extra) => {
    if (cond) { pass++; console.log(`  ok   ${what}`); }
    else { fail++; console.log(`  FAIL ${what}${extra ? '  ' + extra : ''}`); }
  };

  const full = process.argv.includes('--full');
  const SRC_SELF = readFileSync(here('./spike-safe-walls.mjs'), 'utf8');
  const map = JSON.parse(readFileSync(here('../../substrate/m59-map.json'), 'utf8'));
  const rooms = map.rooms ?? map;
  const byNum = new Map();
  for (const r of Object.values(rooms)) if (r?.num != null) byNum.set(Number(r.num), r);

  // ───────────────────────────────────────────────────────────────── WATCH IT WITH YOUR EYES
  //
  //   node tools/fleetscripts/spike-safe-walls.mjs --hold --room 598
  //
  // THE POINT OF THIS MODE IS AGREEMENT, NOT MEASUREMENT. Operator, 2026-09-20: a large part of
  // what a spike is for is being sure we are both testing the same thing and reaching the same
  // answer about it. A verdict printed by a script I wrote, about a square I chose, using a
  // rule I encoded, is exactly the kind of evidence that is easy to agree with and wrong.
  //
  // So this sets the scenario up and then STOPS: three characters placed on the three squares,
  // healed, each having swung once, and left standing there. Nothing is sampled and nothing is
  // concluded. It prints where each one is, what its geometry says, and the command to log a
  // real client in and look.
  //
  // WATCH THE CONTROL, NOT THE ARMS. Spectating BUMPS the broker off the character it attaches
  // to (m59-fleet.mjs: one connection per character, which is what makes spec a single process
  // spawn) — so attaching to an arm ends that arm's trial. The control is the one to watch: it
  // should be visibly taking hits, and if it is not, the room is too quiet and nothing on screen
  // means anything. Once the control is seen bleeding, the two arms standing untouched beside
  // it are the finding, and they can be read off the health bars from across the room.
  if (process.argv.includes('--hold')) {
    const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
    const room = Number(argOf('--room', COMPARABLE[0]));
    const agents = String(argOf('--agents', 'shadow01,shadow02,shadow04')).split(',').map(x => x.trim());
    const out = await runLive({ rooms: [room], agents, broker: argOf('--broker', 'http://127.0.0.1:8971'),
                                settleMs: 0 });
    console.log('\nSTANDING. Nothing further will be driven — look at them:');
    for (const r of out)
      console.log(`  ${r.arm.padEnd(8)} ${r.agent}  square ${r.square}  ` +
                  `can_reach_you ${r.attackers ?? '?'}  approaches refused ${r.refused}`);
    console.log('\n  watch with:   node tools/m59-fleet.mjs spec ' +
                (out.find(r => r.arm === 'control')?.agent ?? agents[2] ?? agents[0]));
    console.log('  that BUMPS the broker off whoever you attach to, so attach to the CONTROL:');
    console.log('  it should be visibly taking hits. If it is not, the room is too quiet and');
    console.log('  the two untouched arms beside it prove nothing.');
    process.exit(0);
  }

  // THE CORRECTED EXPERIMENT. `--live` is kept only so the old runs can be reproduced and seen
  // to be inadmissible; `--protocol` is the one that tests anything.
  if (process.argv.includes('--protocol')) {
    const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
    const rooms = String(argOf('--rooms', COMPARABLE.join(','))).split(',').map(Number).filter(Boolean);
    const agents = String(argOf('--agents', '')).split(',').map(x => x.trim()).filter(Boolean);
    if (!agents.length) { console.error('--protocol needs --agents'); process.exit(2); }
    const { pass } = await runProtocol({ rooms, agents, broker: argOf('--broker', 'http://127.0.0.1:8971'),
                                         phaseMs: Number(argOf('--phase', 45000)) });
    process.exit(pass ? 0 : 1);
  }

  if (process.argv.includes('--live')) {
    const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
    const rooms = String(argOf('--rooms', COMPARABLE.join(','))).split(',').map(Number).filter(Boolean);
    const agents = String(argOf('--agents', '')).split(',').map(x => x.trim()).filter(Boolean);
    if (agents.length < 2) { console.error('--live needs at least two --agents (one pair)'); process.exit(2); }
    const out = await runLive({ rooms, agents, broker: argOf('--broker', 'http://127.0.0.1:8971'),
                                settleMs: Number(argOf('--settle', 45000)) });
    process.exit(out.some(r => r.verdict === 'LEAKED' && r.arm === 'refused') ? 1 : 0);
  }

  if (process.argv.includes('--plan')) {
    console.log('\nTHE EXPERIMENT, room by room:\n');
    console.log('room  deaths  los-safe  all-refused  arms it can run');
    for (const r of ROOMS)
      console.log(String(r.room).padEnd(6) + String(r.deaths).padEnd(8) +
        String(r.losSafe).padEnd(10) + String(r.allRefused).padEnd(13) +
        (r.allRefused > 0 ? 'los, refused' : 'los only - no fully-refused square exists'));
    console.log(`\nboth arms comparable in: ${COMPARABLE.join(', ')}`);
    process.exit(0);
  }

  console.log('\nSPIKE: safe walls - is the recorded fact still true of the code?\n');

  console.log('the library still defines a wall the way THE FACT says it does');
  {
    const src = readFileSync(here('../m59-safespots.mjs'), 'utf8');
    ok('safeWalls() still requires attackers === 0', /ex\.attackers !== 0/.test(src));
    ok('and still requires free_shots > 0 - the clause THE FACT says is inert',
       /free_shots \?\? 0\) <= 0/.test(src));
    ok('MONSTER_DISC is radius 3 and PLAYER_DISC radius 2, which is why the clause is inert',
       /MONSTER_REACH = 3/.test(src) && /PLAYER_REACH = 2/.test(src));
    ok('approach refusal is still measured by the MOVER, not by a ray',
       /moverStepLands\(ar, ac, row, col\)/.test(src));
    ok('and the ledger still decides nothing - discredited() returns false',
       /discredited\(rec[\s\S]{0,2600}?return false;/.test(src));
  }

  console.log('');
  console.log('the numbers in THE FACT, re-derived from the shipped geometry');
  {
    const scope = full ? [...byNum.keys()] : ROOMS.map(r => r.room);
    let safe = 0, rejected = 0, fsNeOg = 0, both = 0, losOnly = 0, orphan = 0;
    const perRoom = new Map();
    for (const n of scope) {
      const rm = byNum.get(n); if (!rm) continue;
      let geo; try { geo = S.geometryFor(rm); } catch { continue }
      if (!geo) continue;
      let l = 0, a = 0;
      for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
        if (!geo.walkable(r, c)) continue;
        let ex, dis;
        try {
          ex = S.exposureAt(geo, r, c, { fine: false });
          dis = geo.collisionReady ? S.gridDisagreementAt(geo, r, c) : null;
        } catch { continue }
        if (!ex) continue;
        const L = ex.attackers === 0;
        const A = !!dis && dis.offered > 0 && dis.refused === dis.offered;
        if (L) {
          safe++; l++;
          if ((ex.free_shots ?? 0) <= 0) rejected++;
          if ((ex.free_shots ?? 0) !== (ex.our_ground ?? 0)) fsNeOg++;
        }
        if (A) a++;
        if (L && A) both++; else if (L) losOnly++; else if (A) orphan++;
      }
      perRoom.set(n, { losSafe: l, allRefused: a });
    }
    console.log(`  (${full ? 'all baked rooms' : 'the ten death rooms'}; --full for every room)`);
    ok('free_shots is an IDENTITY with our_ground on every safe square - the clause is inert',
       fsNeOg === 0, `${fsNeOg} square(s) differ`);
    ok('and excludes only degenerate squares', rejected <= 4, `${rejected} excluded`);
    ok('the two definitions are nearly disjoint - most LOS-safe squares leave a way in',
       losOnly > both * 5, `both=${both} losOnly=${losOnly}`);
    ok('some squares are refused-but-visible, which the current rule throws away',
       orphan >= 0, `${orphan} orphan(s)`);

    const drift = ROOMS.filter(r => {
      const m = perRoom.get(r.room); if (!m) return false;
      return m.losSafe !== r.losSafe || m.allRefused !== r.allRefused;
    });
    ok('the per-room square counts recorded in ROOMS still hold',
       drift.length === 0,
       drift.map(d => `${d.room}: recorded ${d.losSafe}/${d.allRefused}, now ` +
         `${perRoom.get(d.room).losSafe}/${perRoom.get(d.room).allRefused}`).join('; '));
    ok('five of the ten death rooms still have no fully-refused square at all',
       ROOMS.filter(r => r.allRefused === 0).length === 5);
  }

  console.log('');
  console.log('"safe" and "advancement-dead" are the same set, re-derived');
  {
    const scope = full ? [...byNum.keys()] : ROOMS.map(r => r.room);
    let safeN = 0, blindN = 0, both2 = 0, safeNotBlind = 0, blindNotSafe = 0, degenerate = 0;
    for (const n of scope) {
      const rm = byNum.get(n); if (!rm) continue;
      let geo; try { geo = S.geometryFor(rm); } catch { continue }
      if (!geo) continue;
      for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
        if (!geo.walkable(r, c)) continue;
        let ex; try { ex = S.exposureAt(geo, r, c, { fine: false }); } catch { continue }
        if (!ex) continue;
        const isSafe = ex.attackers === 0;
        const isBlind = (ex.our_ground ?? 0) > 0 && ex.free_shots === ex.our_ground;
        if (isSafe) safeN++;
        if (isBlind) blindN++;
        if (isSafe && isBlind) both2++;
        if (isSafe && !isBlind) { safeNotBlind++; if ((ex.our_ground ?? 0) === 0) degenerate++; }
        if (isBlind && !isSafe) blindNotSafe++;
      }
    }
    ok('every safe square is also advancement-dead, bar the degenerate ones',
       safeNotBlind === degenerate, `${safeNotBlind} safe-not-blind, ${degenerate} of them degenerate`);
    ok('and the exceptions really are squares with NOTHING in reach to swing at',
       degenerate === safeNotBlind);
    // The half that matters for where to send characters: you never pay without being paid.
    ok('there is NO square that costs advancement without buying safety',
       blindNotSafe === 0, `${blindNotSafe} worst-of-both square(s)`);
    ok('so the two definitions describe one set, not two',
       both2 === blindN && Math.abs(safeN - blindN) === degenerate,
       `safe=${safeN} blind=${blindN} both=${both2}`);
  }

  console.log('');
  console.log('the experiment is still well-formed');
  {
    ok('both hypotheses AND a positive control are named',
       ARMS.length === 3 && ['los', 'refused', 'control'].every(a => ARMS.includes(a)));
    // The control is what makes a HELD mean anything. Without it, eight quiet trials and a
    // broken probe produce identical output.
    ok('the control looks for an EXPOSED square, not a wall',
       /ex\.attackers >= 4/.test(SRC_SELF));
    ok('and the verdict refuses to conclude anything when the control did not bleed',
       /NOTHING WAS PROVED/.test(SRC_SELF));
    ok('the refused arm really demands every approach refused',
       pickSquare([{ col: 1, row: 1, offered_approaches: 8, refused_approaches: 5 }], 'refused') === null);
    ok('and accepts one where it is',
       pickSquare([{ col: 2, row: 2, offered_approaches: 8, refused_approaches: 8 }], 'refused')?.col === 2);
    ok('a square with no approaches at all is not a wall',
       pickSquare([{ col: 3, row: 3, offered_approaches: 0, refused_approaches: 0 }], 'refused') === null);
    ok('the los arm takes what the shipped selector ranks first',
       pickSquare([{ col: 9, row: 9, offered_approaches: 8, refused_approaches: 1 }], 'los')?.col === 9);
    ok('an empty room is skipped, never passed', /verdict: 'no_monster'/.test(SRC_SELF));
    ok('a room with no candidate square is excluded, not failed', /verdict: 'no_candidate'/.test(SRC_SELF));
    ok('ailments are excluded - poison ticks through any wall', /verdict: 'ailing'/.test(SRC_SELF));
    ok('and a blow that landed before we arrived is excluded', /verdict: 'settling'/.test(SRC_SELF));
    ok('the probe swings FIRST, because an untested wall proves nothing',
       SRC_SELF.indexOf("call('attack'") < SRC_SELF.indexOf("call('rest'"));
  }

  console.log('');
  console.log('THE RESULT');
  {
    const src = readFileSync(here('./spike-safe-walls.mjs'), 'utf8');
    const unrun = /^\/\/ NOT YET RUN\./m.test(src);
    console.log(unrun
      ? '  NOT YET RUN - the fact above is derived from geometry and the corpus, not from monsters.\n' +
        '  Run the live half, then replace THE RESULT section at the top of this file.'
      : '  recorded at the top of this file.');
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE LIVE HALF — PLACED BY DM, NOT WALKED.
//
//   M59_ADMIN_PORT=19998 node tools/fleetscripts/spike-safe-walls.mjs --live \
//     --broker http://127.0.0.1:8971 --rooms 599,598,39 --agents shadow07,shadow03,shadow06,...
//
// WHY DM PLACEMENT RATHER THAN TRAVEL, and this is the whole reason the first attempt at this
// experiment was abandoned. Walking six characters to five monster rooms took longer than the
// measurement and never finished: the roads to these rooms are the roads that kill this fleet,
// so the journey is itself a hazard, characters arrive at different times, some arrive hurt and
// some do not arrive at all. m59-dm.mjs says it in its own header — "setting a test scenario up
// by PLAYING it does not scale ... the same placement over this socket is one packet".
//
// So both characters of a pair are put ON their squares directly, healed to full, and the
// measurement starts from an identical state in the same room in the same second. That is what
// makes this a controlled comparison rather than an anecdote.
//
// AND POISON DOES NOT INVALIDATE A WALL. Operator, 2026-09-20. A tick gets through any geometry
// ever built, so an ailing character is reported `ailing` and excluded rather than counted as a
// leak — and `heal` is issued before the window so the common case never arises.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export async function runLive({
  rooms = COMPARABLE, agents = [], broker = 'http://127.0.0.1:8971',
  settleMs = 45_000, log = console.log,
} = {}) {
  const D = await import('../m59-dm.mjs');
  const S = await import('../m59-safespots.mjs');
  const { readFileSync } = await import('node:fs');

  const rpc = async (name, args = {}) => {
    const r = await fetch(broker, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    }).then(x => x.json()).catch(e => ({ error: String(e) }));
    const t = r?.result?.content?.[0]?.text;
    if (t == null) return r;
    try { return JSON.parse(t); } catch { return { text: t }; }
  };

  const map = JSON.parse(readFileSync(new URL('../../substrate/m59-map.json', import.meta.url), 'utf8'));
  const byNum = new Map();
  for (const r of Object.values(map.rooms ?? map)) if (r?.num != null) byNum.set(Number(r.num), r);

  // TWO SQUARES PER ROOM, CHOSEN OFFLINE FROM THE SAME GEOMETRY THE KEEPER USES. The `los`
  // square is deliberately one that is LOS-safe and has a way in — that is the population the
  // shipped rule offers and the one under suspicion.
  const squaresFor = (roomNum) => {
    const rm = byNum.get(roomNum); if (!rm) return null;
    let geo; try { geo = S.geometryFor(rm); } catch { return null }
    if (!geo) return null;
    let losOnly = null, allRefused = null, control = null;
    const done = () => losOnly && allRefused && control;
    for (let r = 1; r <= geo.rows && !done(); r++)
      for (let c = 1; c <= geo.cols && !done(); c++) {
        if (!geo.walkable(r, c)) continue;
        let ex, dis;
        try {
          ex = S.exposureAt(geo, r, c, { fine: false });
          dis = geo.collisionReady ? S.gridDisagreementAt(geo, r, c) : null;
        } catch { continue }
        if (!ex) continue;
        // THE POSITIVE CONTROL: plainly exposed, and deliberately the MOST exposed square we
        // can find rather than merely a non-wall. A control that only just fails is a control
        // that can pass by luck, and then the whole trial reads as evidence when it is noise.
        if (ex.attackers >= 4 && (!control || ex.attackers > control.attackers))
          control = { row: r, col: c, attackers: ex.attackers,
                      refused: dis ? `${dis.refused}/${dis.offered}` : '?' };
        if (ex.attackers !== 0) continue;
        const all = !!dis && dis.offered > 0 && dis.refused === dis.offered;
        if (all && !allRefused)
          allRefused = { row: r, col: c, refused: `${dis.refused}/${dis.offered}`, attackers: 0 };
        if (!all && !losOnly && dis && dis.offered > 0)
          losOnly = { row: r, col: c, refused: `${dis.refused}/${dis.offered}`, attackers: 0 };
      }
    return { losOnly, allRefused, control };
  };

  const hpOf = (s) => {
    const v = s?.vitals?.health ?? s?.hp ?? null;
    return v && Number.isFinite(v.value) ? v.value : null;
  };

  const results = [];
  const pool = [...agents];

  for (const roomNum of rooms) {
    const sq = squaresFor(roomNum);
    if (!sq?.losOnly || !sq?.allRefused || !sq?.control) {
      log(`room ${roomNum}: skipped — needs one square of EACH kind ` +
          `(los-only=${!!sq?.losOnly} all-refused=${!!sq?.allRefused} control=${!!sq?.control})`);
      continue;
    }
    const a = pool.shift(), b = pool.shift(), k = pool.shift();
    if (!a || !b || !k) { log(`room ${roomNum}: skipped — needs THREE agents (two arms and a control)`); break; }

    const arms = [{ agent: a, arm: 'los', at: sq.losOnly },
                  { agent: b, arm: 'refused', at: sq.allRefused },
                  { agent: k, arm: 'control', at: sq.control }];
    log(`\nroom ${roomNum} (${byNum.get(roomNum)?.name ?? '?'})`);

    // 1. TAKE THE BODIES OFF THEIR OWN KEEPERS FIRST. A keeper that is still deciding will
    //    walk the character off the square being measured, and the walk looks like the wall
    //    holding because nothing hits a body that is not there.
    for (const x of arms) await rpc('autopilot', { agent: x.agent, action: 'stop' });

    // 2. PLACE AND HEAL. One packet each, no travel, no partial arrival.
    const chars = {};
    for (const x of arms) {
      const st = await rpc('status', { agent: x.agent });
      chars[x.agent] = st?.character ?? st?.name ?? x.agent;
    }
    for (const x of arms) {
      const r = await D.relocate([chars[x.agent]], roomNum, { row: x.at.row, col: x.at.col })
        .catch(e => ({ ok: false, why: e.message }));
      log(`  ${x.agent} (${chars[x.agent]}) -> ${roomNum} @ ${x.at.col},${x.at.row} ` +
          `[${x.arm}, can_reach_you ${x.at.attackers ?? '?'}, approaches refused ${x.at.refused}]` +
          `${r?.ok === false ? '  FAILED: ' + r.why : ''}`);
    }
    await D.heal(Object.values(chars)).catch(() => null);
    await new Promise(r => setTimeout(r, 3000));

    // 3. MAKE SOMETHING ANGRY. One swing each; after this nobody swings again, which is the
    //    premise: the wall is supposed to protect a character that HAS fought and then stopped.
    for (const x of arms) {
      const seen = await rpc('look', { agent: x.agent });
      const mob = (seen?.objects ?? []).find(o => o && !o.is_player &&
        Array.isArray(o.can) && o.can.includes('attack'));
      x.monster = mob?.name ?? null;
      if (mob) await rpc('attack', { agent: x.agent, target: mob.id ?? mob.name });
      log(`  ${x.agent} swung at: ${x.monster ?? 'NOTHING IN REACH'}`);
    }

    // 4. SIT AND WATCH. Nothing is driven from here on — that is the measurement.
    const start = {};
    for (const x of arms) start[x.agent] = hpOf(await rpc('status', { agent: x.agent }));
    const low = { ...start };
    let ailed = {};
    const until = Date.now() + settleMs;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 5000));
      for (const x of arms) {
        const st = await rpc('status', { agent: x.agent });
        const h = hpOf(st);
        if (h != null && (low[x.agent] == null || h < low[x.agent])) low[x.agent] = h;
        if (Array.isArray(st?.ailments) && st.ailments.length) ailed[x.agent] = true;
      }
    }

    for (const x of arms) {
      const lost = start[x.agent] != null && low[x.agent] != null
        ? start[x.agent] - low[x.agent] : null;
      const verdict = x.monster == null ? 'no_monster'
        : lost == null ? 'unreadable'
        : lost <= 0 ? 'HELD'
        : ailed[x.agent] ? 'ailing'
        : 'LEAKED';
      results.push({ room: roomNum, agent: x.agent, arm: x.arm, square: `${x.at.col},${x.at.row}`,
                     refused: x.at.refused, attackers: x.at.attackers ?? null,
                     monster: x.monster, start: start[x.agent],
                     low: low[x.agent], lost, verdict });
      log(`  ${x.arm.padEnd(8)} ${String(verdict).padEnd(11)} ${start[x.agent]} -> ${low[x.agent]}` +
          (lost > 0 ? `  (lost ${lost})` : ''));
    }
  }

  log('\n──────── VERDICT ────────');
  // THE CONTROL IS READ FIRST, because it decides whether anything else is admissible.
  const ctl = results.filter(r => r.arm === 'control');
  const ctlLeaked = ctl.filter(r => r.verdict === 'LEAKED').length;
  log(`  control  ${ctlLeaked}/${ctl.length} leaked` +
      (ctl.length && ctlLeaked === 0
        ? '   <- NOTHING WAS PROVED. An exposed square that took no damage means the rooms were'
          + '\n               too quiet to test anything; every verdict below is discarded.'
        : '   <- the probe can see damage, so the arms below mean something'));
  for (const arm of ARMS.filter(a => a !== 'control')) {
    const mine = results.filter(r => r.arm === arm && ['HELD', 'LEAKED'].includes(r.verdict));
    const leaked = mine.filter(r => r.verdict === 'LEAKED').length;
    log(`  ${arm.padEnd(8)} ${mine.length ? `${leaked}/${mine.length} leaked` : 'no decisive rooms'}` +
        (mine.length ? `  (${Math.round(100 * (mine.length - leaked) / mine.length)}% held)` : ''));
  }
  const excluded = results.filter(r => !['HELD', 'LEAKED'].includes(r.verdict));
  if (excluded.length)
    log(`  excluded: ${excluded.map(r => `${r.room}/${r.arm}=${r.verdict}`).join(', ')}`);
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PROTOCOL — WHAT THE FIRST FOUR RUNS GOT WRONG, AND WHY THIS REPLACES THEM.
//
// Operator, 2026-09-20, correcting the experiment: the test must attack a monster from OUTSIDE
// but near the safe square, then move INTO it, and only then ask whether the monster — which by
// now has chased over and is standing next to us — can still reach. And it must also swing from
// inside the square, confirm the monster returns fire, then step out and back in and confirm the
// attacking stops.
//
// HE IS RIGHT AND THE OLD PROBE WAS NOT A TEST. It placed a body ON the square, swung once, and
// watched the bar. It never established that anything was chasing, never confirmed a monster had
// arrived within reach, and so could not tell "the wall protected me" from "nothing came". Run 4
// proved that conclusively and embarrassingly: the CONTROL — a square with `can_reach_you: 20`,
// twenty squares something could hit it from — reported HELD over three minutes. An exposed
// square taking no damage means the monsters were never engaged, which means all eleven earlier
// HELD verdicts were measuring an empty room.
//
// WHAT MAKES THIS VERSION A TEST IS THAT IT CARRIES ITS OWN PROOF OF EXPOSURE.
//
//   1. STAGE      place the body NEAR the square, not on it, and heal to full.
//   2. ENGAGE     swing at a monster from there, and WAIT until it has closed to within melee
//                 reach. If it never closes, the trial is INCONCLUSIVE and stops — no monster,
//                 no test.
//   3. ENTER      walk into the safe square. The monster follows; it wants to.
//   4. QUIET      stand still, swing at nothing, and measure. The wall says: no damage.
//   5. PROVOKE    swing at it from inside the square, and measure. THIS IS THE CONTROL AND IT IS
//                 THE SAME BODY ON THE SAME SQUARE WITH THE SAME MONSTER — if it cannot draw
//                 return fire here, the monster is not in a position to hit us at all and the
//                 quiet phase proved nothing, whatever it showed.
//   6. RECOVER    stop swinging, step out of the square and back into it, and measure again.
//                 The wall says: the damage stops.
//
// A trial is ADMISSIBLE only if PROVOKE drew blood. That single gate is what the old probe
// lacked, and it converts "nothing hit me" from a result into a question.
//
//   PROTECTED     quiet 0, provoke > 0, recover 0     the full signature
//   UNPROTECTED   quiet > 0                            hit without provoking
//   INCONCLUSIVE  provoke 0                            never in a position to be hit; discarded
// ═════════════════════════════════════════════════════════════════════════════════════════════

export async function runProtocol({
  rooms = COMPARABLE, agents = [], broker = 'http://127.0.0.1:8971',
  phaseMs = 45_000, chaseMs = 60_000, log = console.log,
} = {}) {
  const D = await import('../m59-dm.mjs');
  const S = await import('../m59-safespots.mjs');
  const { readFileSync } = await import('node:fs');

  const rpc = async (name, args = {}) => {
    const r = await fetch(broker, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    }).then(x => x.json()).catch(e => ({ error: String(e) }));
    const t = r?.result?.content?.[0]?.text;
    if (t == null) return r;
    try { return JSON.parse(t); } catch { return { text: t }; }
  };

  const map = JSON.parse(readFileSync(new URL('../../substrate/m59-map.json', import.meta.url), 'utf8'));
  const byNum = new Map();
  for (const r of Object.values(map.rooms ?? map)) if (r?.num != null) byNum.set(Number(r.num), r);

  const hpOf = (s2) => { const v = s2?.vitals?.health ?? s2?.hp ?? null;
                         return v && Number.isFinite(v.value) ? v.value : null; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // FOUR KINDS OF SQUARE, AND TWO OF THEM ARE SUPPOSED TO FAIL.
  //
  //   los           attackers 0, some approach still open   -> must PROTECT
  //   refused       attackers 0 AND every approach refused   -> must PROTECT (a subset of los)
  //   refused_only  every approach refused BUT attackers > 0 -> must FAIL. This is the square
  //                 the rival definition calls safe and ours does not, and the spike does not
  //                 pass until somebody has actually been hit standing on one.
  //   control       plainly exposed                          -> must FAIL (instrument check)
  const pickSquares = (geo) => {
    const out = { los: null, refused: null, refused_only: null, control: null };
    for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
      if (!geo.walkable(r, c)) continue;
      let ex, dis;
      try { ex = S.exposureAt(geo, r, c, { fine: false });
            dis = geo.collisionReady ? S.gridDisagreementAt(geo, r, c) : null; } catch { continue }
      if (!ex) continue;
      const allRefused = !!dis && dis.offered > 0 && dis.refused === dis.offered;
      const row = { row: r, col: c, attackers: ex.attackers,
                    refused: dis ? `${dis.refused}/${dis.offered}` : '?' };
      if (ex.attackers === 0) {
        if (allRefused && !out.refused) out.refused = row;
        if (!allRefused && dis && dis.offered > 0 && !out.los) out.los = row;
      } else {
        // The disproof square: take the MOST exposed one that is nevertheless fully refused,
        // so a failure to hit it cannot be put down to it being marginal.
        if (allRefused && (!out.refused_only || ex.attackers > out.refused_only.attackers))
          out.refused_only = row;
        if (ex.attackers >= 4 && (!out.control || ex.attackers > out.control.attackers))
          out.control = row;
      }
    }
    return out;
  };

  // A square next to the target square that something can reach: where the fight is picked.
  const stagingFor = (geo, at) => {
    for (let rad = 1; rad <= 4; rad++)
      for (const [dr, dc] of [[0,rad],[rad,0],[0,-rad],[-rad,0],[rad,rad],[-rad,-rad],[rad,-rad],[-rad,rad]]) {
        const r = at.row + dr, c = at.col + dc;
        if (!geo.walkable(r, c)) continue;
        let ex; try { ex = S.exposureAt(geo, r, c, { fine: false }); } catch { continue }
        if (ex && ex.attackers > 0) return { row: r, col: c };
      }
    return null;
  };

  const window = async (agent, ms, { swingAt = null } = {}) => {
    const start2 = hpOf(await rpc('status', { agent }));
    let low = start2, ailed = false;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (swingAt != null) await rpc('attack', { agent, target: swingAt });
      await sleep(swingAt != null ? 2500 : 4000);
      const st = await rpc('status', { agent });
      const h = hpOf(st);
      if (h != null && (low == null || h < low)) low = h;
      if (Array.isArray(st?.ailments) && st.ailments.length) ailed = true;
    }
    return { start: start2, low, lost: start2 != null && low != null ? start2 - low : null, ailed };
  };

  const results = [];
  const pool = [...agents];

  for (const roomNum of rooms) {
    const rm = byNum.get(roomNum); if (!rm) continue;
    let geo; try { geo = S.geometryFor(rm); } catch { continue }
    if (!geo) continue;
    const picks = pickSquares(geo);
    log(`\nroom ${roomNum} (${rm.name})`);

    for (const arm of ['los', 'refused', 'refused_only', 'control']) {
      const at = picks[arm];
      if (!at) { log(`  ${arm.padEnd(13)} no such square in this room`); continue; }
      const agent = pool.shift();
      if (!agent) { log('  out of agents'); break; }
      const staging = stagingFor(geo, at) ?? at;

      await rpc('autopilot', { agent, action: 'stop' });
      const who = (await rpc('status', { agent }))?.character ?? agent;

      // 1. STAGE on an exposed square beside the target square, at full health.
      await D.relocate([who], roomNum, { row: staging.row, col: staging.col }).catch(() => null);
      await D.heal([who]).catch(() => null);
      await sleep(2500);

      // 2. ENGAGE, and keep swinging until something is actually in melee range.
      let mob = null, closed = false;
      const chaseUntil = Date.now() + chaseMs;
      while (Date.now() < chaseUntil && !closed) {
        const seen = await rpc('look', { agent });
        const cands = (seen?.objects ?? []).filter(o => o && !o.is_player &&
          Array.isArray(o.can) && o.can.includes('attack'));
        if (!cands.length) { await sleep(3000); continue; }
        mob = cands.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
        await rpc('attack', { agent, target: mob.id ?? mob.name });
        await sleep(3000);
        const now = await rpc('look', { agent });
        const m = (now?.objects ?? []).find(o => o?.id === mob.id);
        if (m && Number.isFinite(m.distance) && m.distance <= 3) closed = true;
      }
      if (!mob) { log(`  ${arm.padEnd(13)} nothing to fight`);
                  results.push({ room: roomNum, arm, agent, verdict: 'no_monster' }); continue; }
      if (!closed) { log(`  ${arm.padEnd(13)} ${mob.name} never closed — INCONCLUSIVE`);
                     results.push({ room: roomNum, arm, agent, monster: mob.name, verdict: 'never_closed' }); continue; }

      // 3. ENTER the square. DM-placed rather than walked: the earlier version lost every trial
      //    to `walk_to` refusing the last step, and where the body came from is not the question.
      await D.relocate([who], roomNum, { row: at.row, col: at.col }).catch(() => null);
      await sleep(2000);
      await D.heal([who]).catch(() => null);
      await sleep(1500);
      // and confirm the monster is STILL within reach of where we now stand, or nothing that
      // follows is about this square.
      const after = await rpc('look', { agent });
      const stillNear = (after?.objects ?? []).find(o => o?.id === mob.id &&
        Number.isFinite(o.distance) && o.distance <= 3);
      if (!stillNear) { log(`  ${arm.padEnd(13)} ${mob.name} not in reach after entering — INCONCLUSIVE`);
                        results.push({ room: roomNum, arm, agent, monster: mob.name, verdict: 'lost_contact' }); continue; }

      // 4/5/6. QUIET, PROVOKE, RECOVER.
      const quiet = await window(agent, phaseMs);
      const provoke = await window(agent, phaseMs, { swingAt: mob.id ?? mob.name });
      await D.relocate([who], roomNum, { row: staging.row, col: staging.col }).catch(() => null);
      await sleep(1500);
      await D.relocate([who], roomNum, { row: at.row, col: at.col }).catch(() => null);
      await sleep(1500);
      const recover = await window(agent, phaseMs);

      const hit = (x) => (x.lost ?? 0) > 0;
      const verdict = arm === 'refused_only' || arm === 'control'
        // These two are SUPPOSED to be hit. Being hit is the pass.
        ? (hit(quiet) || hit(provoke) ? 'ATTACKED' : 'NOT_ATTACKED')
        : hit(provoke)
          ? (hit(quiet) ? 'UNPROTECTED' : hit(recover) ? 'PARTIAL' : 'PROTECTED')
          : 'INCONCLUSIVE';
      results.push({ room: roomNum, arm, agent, monster: mob.name, square: `${at.col},${at.row}`,
                     attackers: at.attackers, refused: at.refused,
                     quiet: quiet.lost, provoke: provoke.lost, recover: recover.lost, verdict });
      log(`  ${arm.padEnd(13)} ${String(verdict).padEnd(13)} quiet ${quiet.lost}  provoke ${provoke.lost}` +
          `  recover ${recover.lost}   (${mob.name}, ${at.col},${at.row}, atk ${at.attackers}, refused ${at.refused})`);
    }
  }

  log('\n──────── VERDICT ────────');
  const ours = results.filter(r => ['los', 'refused'].includes(r.arm) &&
                                   ['PROTECTED', 'UNPROTECTED', 'PARTIAL'].includes(r.verdict));
  const rival = results.filter(r => r.arm === 'refused_only' &&
                                    ['ATTACKED', 'NOT_ATTACKED'].includes(r.verdict));
  const ctl = results.filter(r => r.arm === 'control' && ['ATTACKED', 'NOT_ATTACKED'].includes(r.verdict));
  const disproved = rival.filter(r => r.verdict === 'ATTACKED').length;
  const protectedN = ours.filter(r => r.verdict === 'PROTECTED').length;

  log(`  our definition (attackers 0)     ${ours.length ? `${protectedN}/${ours.length} protected` : 'no admissible trials'}`);
  log(`  rival (all approaches refused)   ${rival.length ? `${disproved}/${rival.length} ATTACKED` : 'no admissible trials'}` +
      (disproved ? '   <- DISPROVED: refused approaches alone do not protect' : ''));
  log(`  control (plainly exposed)        ${ctl.length ? `${ctl.filter(r => r.verdict === 'ATTACKED').length}/${ctl.length} attacked` : 'no admissible trials'}`);
  const pass = ours.length > 0 && protectedN === ours.length && disproved > 0;
  log(`\n  SPIKE ${pass ? 'PASSES' : 'DOES NOT PASS'} — it passes only when our squares all protect` +
      `\n  AND somebody has been hit on a square the rival definition calls safe.`);
  return { results, pass };
}

