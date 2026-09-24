#!/usr/bin/env node
// PLAYING DEAD ON A SAFE SPOT, PINNED — AND THE TURN THAT MAKES IT WORTH ANYTHING.
//
// Offline: no socket, no roster, no broker. The session is a fake and the only thing that
// leaves it is a recorded list of what was sent.
//
// WHAT THIS GUARDS. Playing dead buys safety by not acting, and the same flag that keeps
// the monsters off keeps HealthTimer off with it — so a freeze recovers vigor and NEVER
// health (player.kod:5613, gated on PFLAG_MOVED_SINCE_ENTRY). Out in the open that is the
// whole trade and there is no way around it: the only thing that arms the timer is moving,
// and moving is what gets you hit.
//
// A safe spot is the one place in this game where that is not true. Nothing can reach the
// square, so a TURN — which sets the flag and gives up no ground — costs exactly nothing.
// Being unreachable AND healing is available on a safe spot and nowhere else, and it is the
// entire reason safe spots are worth the machinery behind them.
//
// So the failure this pins is a quiet one: come back on the spot, do not turn, and the
// character is unreachable and healing at zero. That looks identical to working. It reads
// as a wall that holds — because the wall does hold — while the health sits at four.

import { Autopilot } from './m59-autopilot.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const SPOT = { col: 23, row: 6, x: 32, y: 32, proven: true };

// A session that records rather than sends. `sent` is the whole assertion surface.
function fakeSession({ health = 12, max = 40, backAt = SPOT } = {}) {
  const sent = [];
  const client = {
    selfId: 1,
    self: { col: SPOT.col, row: SPOT.row, degrees: 90 },
    room: { objects: new Map() },
    vitals: () => ({ health: { value: health, max }, vigor: { value: 40, max: 200 } }),
    face: to => { sent.push({ kind: 'face', to }); },
    roomContents: () => { sent.push({ kind: 'roomContents' }); },
    waitFor: async () => ({}),
  };
  const s = {
    client, sent,
    need: () => client,
    pacer: { submit: async (lane, fn) => fn() },
    world: { room: { num: 39 } },
    // where the character comes back standing, after the reconnect
    comeBackAt: backAt,
    // Every case here is "hurt with things adjacent", i.e. being hit. A logoff with nothing
    // hitting us is refused before any of this runs — that is m59-logoffgate-test.mjs.
    damagedAt: Date.now(),
  };
  return s;
}

// An Autopilot with everything the freeze path touches stubbed, and nothing else.
function keeper(s, over = {}) {
  const a = Object.create(Autopilot.prototype);
  a.s = s;
  a.policy = {};
  a.tally = {};
  a.notes = [];
  a.note = (msg, detail) => a.notes.push({ msg, detail });
  a.progress = () => {};
  a.noProgress = m => a.notes.push({ msg: 'NOPROGRESS: ' + m });
  a.tellPilot = async () => {};
  a.holdWorks = () => true;
  // `playDead` asks `adoptRecoveryWall()`, not `holdWorks()` — the wall question moved to the
  // FORMULA when the ledger was taken out of it. These fixtures never stubbed it because the
  // verb used to proceed whatever it answered; since 2026-09-18 it gates the open freeze on it,
  // so a fixture that declares a hold has to say the geometry accepts that hold too.
  a.adoptRecoveryWall = () => !!a.hold;
  a.reconnect = async () => {
    // A reconnect is a fresh entry into the room. That is the point: the flag comes back
    // CLEAR, which is what the turn has to fix.
    if (s.comeBackAt) s.client.self = { ...s.client.self, ...s.comeBackAt };
    return { ok: true };
  };
  a.hold = { ...SPOT, takenAt: Date.now() - 5000, quietMs: 4000 };
  Object.assign(a, over);
  return a;
}
const noted = (a, re) => a.notes.some(n => re.test(n.msg));

console.log('coming back on the spot arms the health timer');
{
  const s = fakeSession();
  const a = keeper(s);
  const held = await a.playDead('at 12 health with 3 adjacent');

  ok('the freeze is reported as handled', held === true);
  // THE ONE THAT MATTERS.
  ok('A TURN IS SENT ON THE RECONNECT', s.sent.some(x => x.kind === 'face'),
     JSON.stringify(s.sent));
  ok('and the facing actually changes, or the flag is not set',
     s.sent.find(x => x.kind === 'face')?.to !== 90);
  ok('the turn is recorded, so the rest branch knows the timer is armed',
     Number.isFinite(a.turnedAt));
  ok('the spot is kept, marked as one we came back to',
     a.hold?.reclaimed === true && a.hold.col === SPOT.col && a.hold.row === SPOT.row);
  ok('and it is reported as a turn that went through',
     a.notes.some(n => n.detail?.turned === true));

  // A verifying turn sleeps and then round-trips room-contents, and comparing a position
  // across up to 2.3 seconds of live combat is what once reported a turn had "moved us off
  // the square" and cost a character a proven spot he was standing on. REQ_TURN carries no
  // coordinates; there is nothing to verify.
  ok('THE TURN DOES NOT ROUND-TRIP ROOM-CONTENTS TO VERIFY ITSELF',
     !s.sent.some(x => x.kind === 'roomContents'));
  // Freezing is what the OTHER branch does. On the spot the walls do the work and the
  // grace period is ours to spend.
  ok('and we are not frozen — the walls are doing the work',
     !a.frozenUntil || a.frozenUntil <= Date.now());
}

console.log('');
console.log('a second freeze would undo the first');
{
  // Playing dead recovers vigor and never health, so the pass after a freeze is at the same
  // health, still doomed and still sheltered — and asks for another one. Granting it clears
  // PFLAG_MOVED_SINCE_ENTRY again, which throws away the only thing the reclaim achieved.
  const s = fakeSession();
  const a = keeper(s);
  await a.playDead('first');
  s.sent.length = 0;
  const again = await a.playDead('and again, no better off');

  ok('THE SECOND FREEZE IS REFUSED', again === false);
  ok('and it is refused for healing, not for failure counting',
     noted(a, /already healing/));
  ok('nothing is sent — no logoff, no turn', s.sent.length === 0, JSON.stringify(s.sent));
  ok('the spot is still held, so the caller rests here rather than leaving',
     a.hold?.col === SPOT.col);
}

console.log('');
console.log('the refusal is about THIS spot, not about spots in general');
{
  // A character that took a fresh spot after the reclaim has an unarmed timer again, and a
  // freeze from there is a real option. Keying the refusal on the hold rather than on a
  // sticky flag is what keeps that true.
  const s = fakeSession();
  const a = keeper(s);
  await a.playDead('first');
  a.hold = { col: 9, row: 9, x: 32, y: 32, takenAt: Date.now(), quietMs: 0 };
  ok('a spot taken since the turn does not inherit the refusal',
     a.hold.reclaimed !== true &&
     !(a.hold.reclaimed && a.turnedAt && a.turnedAt >= a.hold.takenAt));

  const b = keeper(fakeSession(), { hold: null, turnedAt: Date.now() });
  ok('and neither does having turned with no spot at all',
     !(b.hold?.reclaimed && b.turnedAt && b.turnedAt >= b.hold.takenAt));
}

console.log('');
console.log('coming back somewhere else is not a safe spot');
{
  // A reconnect normally puts you back exactly where you were, but the branch above trusts
  // `hold` completely — so believing in a square we are not standing on is worse than
  // freezing. Turning there would be spending the grace period for nothing.
  const s = fakeSession({ backAt: { col: 40, row: 40 } });
  const a = keeper(s);
  const held = await a.playDead('at 12 health');

  ok('the hold is given up', a.hold === null);
  ok('and no turn is sent, because there is no wall to turn behind',
     !s.sent.some(x => x.kind === 'face'), JSON.stringify(s.sent));
  ok('we freeze instead, completely still', held === true && a.frozenUntil > Date.now());
  ok('and say so rather than carrying on', noted(a, /did not come back on the safe spot/));
}

console.log('');
console.log('a turn that does not go through is said out loud');
{
  // Unreachable and healing at zero is the failure that looks exactly like success. If the
  // turn fails there is nothing in the world to observe — the wall still holds, the room
  // still cannot reach us, and the health simply never moves.
  const s = fakeSession();
  s.client.face = () => { throw new Error('squelched'); };
  const a = keeper(s);
  const held = await a.playDead('at 12 health');

  ok('the spot is still held', held === true && a.hold?.reclaimed === true);
  ok('the timer is NOT claimed to be armed', !a.turnedAt);
  ok('IT IS REPORTED AS NO PROGRESS, not as a successful freeze',
     noted(a, /NOPROGRESS: .*could not turn/));
  ok('and the note says rest will pay nothing',
     a.notes.some(n => /REST WILL PAY NOTHING/.test(n.detail?.plan || '')));
  // And crucially it must not then refuse the next freeze: with no armed timer, freezing
  // is still the best thing available.
  ok('a freeze is still available next pass, since nothing is healing',
     !(a.hold?.reclaimed && a.turnedAt && a.turnedAt >= a.hold.takenAt));
}

// ---------------------------------------------------------------------------
// A FREEZE OFF A PROVEN SPOT IS REFUSED — added 2026-08-21, by measurement.
//
// Everything above this pins what a freeze buys ON a safe spot. This pins that it is not
// available anywhere else, which is the other half and the one that was costing lives.
//
// The whole file's fixture stubs `holdWorks = () => true`, so every assertion above runs
// with a wall that holds. That is correct for them and it is exactly why this case has to
// be written separately: the refusal is invisible to a suite that never has a bad spot.
//
// THE EVIDENCE. Shadow fleet, Twisted Wood corridor, 2026-08-21: three characters froze in
// the OPEN at 4, 10 and 13 health, in rooms holding twelve to fifteen monsters, for about
// thirteen seconds each. All three died. Their own journal line said why — "recovering
// vigor; health needs us to move again first". Of 21 deaths in that window, 20 were
// stationary at the moment of death, median 29 seconds still. In that corridor, standing
// still IS the cause of death, and a freeze is a way of standing still on purpose.
console.log('');
console.log('and OFF a wall against MONSTERS it now refuses — the rule reversed twice');
{
  // THIS ARGUMENT HAS GONE BOTH WAYS AND BOTH ROUNDS ARE KEPT, because the second reversal
  // turns on a premise of the first rather than on its logic.
  //
  // ROUND 1, the original refusal, argued from the evidence above: a freeze recovers VIGOR and
  // never health (the logoff flag stops HealthTimer), so off a wall it hands the room several
  // free seconds and changes nothing.
  //
  // ROUND 2, 2026-09-10, the operator reversed it:
  //
  //   "implement fall throughs to the singular correct behavior that would have saved any
  //    character that died in this window: the preexisting play_dead() -- it is universally the
  //    best survival mechanism available... There is truly only one way: The play_dead."
  //
  // The reasoning: the logoff makes the enemy stop attacking IMMEDIATELY, where "waiting and
  // hoping can let the enemy continue attacking for up to dozens of seconds". So off a wall the
  // choice is not healing versus not healing; it is an attack that ends now versus one that
  // continues. Camilla and Rizzo had just died in Ukgoth with `at_a_safe_wall: null`, precisely
  // the state in which the verb answered no.
  //
  // ROUND 3, 2026-09-18, the operator again: "the open freeze should be removed as a tactic or
  // only ever done in PvP, it will not save you from monsters."
  //
  // WHAT DECIDED IT, and it is the premise round 2 never tested: that an attack ending NOW is
  // worth having only if the seconds it buys are spent on something. They are not.
  //
  //   Animal, 2026-09-17, room 599, `in_safe_spot: false`, `hold: null`. Frozen twelve seconds
  //   at 4/55, vigor 135 and never the constraint. Unfroze `before {health: 4} -> now
  //   {health: 4}` -- ZERO health across the whole freeze, because there was no wall to turn
  //   at. Then "logoff did not establish recovery", reached for a spot five steps away, dead
  //   1.4s later.
  //
  // Round 2's own counter-case concedes its characters "had no way out either way", which is an
  // argument that the refusal did not kill them -- not an argument that the freeze saves anyone.
  // Against a PLAYER it is kept: a person can be convinced you are dead; a monster cannot.
  const s = fakeSession({ health: 4, max: 37 });
  const a = keeper(s);
  a.holdWorks = () => false;          // open ground
  a.hold = null;
  a.playerThreatPresent = () => false;   // monsters only
  const froze = await a.playDead('at 4 health with 15 adjacent, nothing that holds');
  ok('playDead REFUSES in the open against monsters', froze === false);
  ok('and it sends nothing at all — no turn, no logoff',
     !s.sent.some(x => x.kind === 'face'), JSON.stringify(s.sent).slice(0, 120));
  ok('and it says why in a line a person can grep',
     a.notes.some(n => /refusing to play dead in the open/.test(n.msg ?? n.what ?? '')),
     JSON.stringify(a.notes.map(n => n.msg ?? n.what)).slice(0, 200));

  // A PLAYER IS THE CARVE-OUT, and it is the whole of it.
  const sp = fakeSession({ health: 4, max: 37 });
  const p = keeper(sp);
  p.holdWorks = () => false;
  p.hold = null;
  p.playerThreatPresent = () => true;
  ok('...but in the open WITH A PLAYER here it still freezes',
     (await p.playDead('a stranger is on us')) !== false);

  // An unproven wall is still not a special case -- proof is not the question, geometry is,
  // and `adoptRecoveryWall` answers it. The operator: "do *not* consult the safe spot ledger
  // regarding safe walls, use the formula".
  const s2 = fakeSession({ health: 6, max: 40 });
  const b = keeper(s2);
  b.holdWorks = () => false;
  b.hold = { col: 1, row: 1, proven: false, takenAt: Date.now() };
  b.adoptRecoveryWall = () => true;      // the formula accepts it; the book is not asked
  b.playerThreatPresent = () => false;
  ok('an unproven wall that the FORMULA accepts still freezes',
     (await b.playDead('on a wall nobody has tested')) !== false);
}
// The rule lives in the VERB, not in one caller, and the caller that used to override it
// is gone. Both pinned by source, because an absence cannot be exercised.
console.log('');
console.log('the rule is enforced where it cannot be routed around');
{
  const SRC = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  // The REFUSAL is what is gone, and an absence has to be pinned by source.
  ok('playDead no longer gates on a book-proven hold',
     !/if \(!this\.holdWorks\(\)\)[\s\S]{0,400}refusing to play dead/.test(SRC));
  ok('and the wall question, where it is still asked, is answered by the GEOMETRY',
     /wallHere\(\) \{/.test(SRC) && /exposureAt\(geo, Math\.round\(row\)/.test(SRC));
  ok('which is the same formula safeWalls uses — attackers must be zero',
     /\(ex\.attackers \?\? 0\) === 0/.test(SRC));
  // THE DOOMED RUNG NO LONGER FORKS. It used to play dead when sheltered and run for a town when
  // not; both are now the one verb, which is what the operator asked for. The town trip survives
  // as an ERRAND (unarmed with no mana, or the vigor/food deadlock) and not as survival.
  const doomed = SRC.slice(SRC.indexOf('if (doomed && this.policy.panicLogoff !== false)'),
                           SRC.indexOf('SIT DOWN PROPERLY THE MOMENT WE ARRIVE'));
  ok('the doomed rung reaches for playDead', /await this\.playDead\(/.test(doomed));
  ok('and no longer runs for a town as a survival move',
     !/townTripIfCornered/.test(doomed), doomed.match(/townTripIfCornered/)?.[0] ?? '');
  ok('and there is no sheltered/unsheltered branch left in it',
     !/if \(sheltered\) \{/.test(doomed));
  // A journey no longer ends for a tactic that will be refused. `flee` catches the same
  // characters (doomed_in_open_below 0.3 sits under flee_below) and hands over to moving.
  ok('play_dead is no longer a travel guard, so it cannot cancel a journey',
     !/play_dead: true/.test(SRC) && !/travelAllows\('play_dead'\)/.test(SRC));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
