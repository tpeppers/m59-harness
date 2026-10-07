// m59-dormancy.mjs, offline: no socket, no roster, a temp directory for the store.
//
//   node tools/m59-dormancy-test.mjs
//
// What it pins: the server's logoff-penalty arithmetic as kod states it (the 540-660 s window, a
// safe room leaving no ghost, and THE CLOCK NOT RESETTING ON A RELOG UNDER 120 s); that every
// reason wakes on its own rule and the penalty guard outranks all of them; that a deadline wake
// without a deadline is refused rather than read as "for ever"; that an unreadable hand-over
// fails CLOSED; and that the store keeps who ended a dormancy.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDormancy, dormancyVerdict, logoffPenalty, logoffIsSafe, withLogoff, LOGOFF_PENALTY,
         PENALTY_MARGIN_MS, SAFE_LOGOFF_ROOMS, encodeDormancy, decodeDormancy, DormancyStore,
         dormancyFileFor } from './m59-dormancy.mjs';

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail ? ' -- ' + detail : ''}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const section = s => console.log(`\n${s}`);
const T = 1_800_000_000_000;
const S = 1000, M = 60_000;

section('the server\'s logoff penalty (user.kod UserLogoff, logghost.kod)');
{
  ok(logoffPenalty({ at: T, safe: true }) === null, 'a safe-logoff room leaves no ghost and no clock');
  const p = logoffPenalty({ at: T, safe: false });
  ok(p.earliest === T + 540 * S && p.latest === T + 660 * S, 'unsafe: struck between 540 and 660 s', JSON.stringify(p));
  ok(p.carried === false && p.assumed_unsafe === false, 'a fresh clock, from a known room');
  ok(logoffPenalty({ at: T, safe: null }).assumed_unsafe === true, 'an unknown room is treated as unsafe, and says so');
  // The relog rule: back on for under 120 s, the ORIGINAL deadline still counts.
  const first = logoffPenalty({ at: T, safe: false });
  const quick = logoffPenalty({ at: T + 200 * S, safe: false, lastLoginAt: T + 100 * S, prior: first });
  ok(quick.carried === true && quick.earliest === first.earliest,
     'on for 100 s and off again: the first logoff\'s clock is still running', JSON.stringify(quick));
  const settled = logoffPenalty({ at: T + 300 * S, safe: false, lastLoginAt: T + 100 * S, prior: first });
  ok(settled.carried === false && settled.earliest === T + 300 * S + 540 * S, 'on for 200 s: a new clock is drawn');
  const unknownLogin = logoffPenalty({ at: T + 200 * S, safe: false, lastLoginAt: null, prior: first });
  ok(unknownLogin.carried === false, 'an unknown login time never carries');
  const inside = logoffPenalty({ at: T + 600 * S, safe: false, lastLoginAt: T + 550 * S, prior: first });
  ok(inside.carried === 'maybe' && inside.earliest === T + 600 * S,
     'inside the old window: the strike we cannot rule out is NOW', JSON.stringify(inside));
  ok(LOGOFF_PENALTY.ghost_ms === 600_000 && LOGOFF_PENALTY.reset_online_ms === 120_000, 'the kod numbers');
  ok(throws(() => logoffPenalty({ safe: false }), /at/), 'a logoff needs a time');
}

section('which rooms are safe to log off in');
{
  ok(logoffIsSafe(52) === true && logoffIsSafe(106) === true && logoffIsSafe(1) === true,
     'the Tos inn, the Barloque inn and the Underworld');
  ok(logoffIsSafe(599) === false && logoffIsSafe(2) === false, 'Ukgoth and Outside Castle Victoria are not');
  ok(logoffIsSafe(714, { guildHallRooms: [714] }) === null, 'a guild hall depends on who and where: unknown');
  ok(logoffIsSafe(null) === null && logoffIsSafe('x') === null, 'no room is unknown');
  ok(SAFE_LOGOFF_ROOMS.size === 23, 'twenty-three rooms carry ROOM_SAFELOGOFF with a fixed RID');
}

section('a request becomes a record, or a reason');
{
  const p = normalizeDormancy({ reason: 'pilot', by: 'restart-keepers' }, { now: T });
  ok(p.wake === 'pilot_released' && p.until === null && p.since === T, 'a pilot dormancy waits for the person', JSON.stringify(p));
  const o = normalizeDormancy({ reason: 'operator', by: 'op' }, { now: T });
  ok(o.wake === 'manual', 'an operator hold with no length lasts until somebody says');
  const o2 = normalizeDormancy({ reason: 'operator', for_ms: 15 * M }, { now: T });
  ok(o2.wake === 'deadline' && o2.until === T + 15 * M, 'with a length, it ends on it');
  ok(throws(() => normalizeDormancy({ reason: 'evade' }, { now: T }), /deadline wake needs/),
     'an evade that forgot its length is refused, not made indefinite');
  ok(throws(() => normalizeDormancy({ reason: 'nap' }), /reason must be/), 'an unknown reason is refused');
  ok(throws(() => normalizeDormancy({ reason: 'operator', wake: 'soon' }), /wake must be/), 'an unknown wake is refused');
  ok(throws(() => normalizeDormancy({ reason: 'operator', until: T - M }, { now: T }), /future/), 'a past deadline is refused');
  ok(normalizeDormancy({ reason: 'operator', note: 'x'.repeat(500) }).note.length === 200, 'a note is bounded');
}

section('when it wakes');
{
  ok(dormancyVerdict(null).dormant === false, 'no record: not dormant');
  const pilot = normalizeDormancy({ reason: 'pilot' }, { now: T });
  ok(dormancyVerdict(pilot, { now: T, pilotHeld: true }).wake === false, 'a pilot dormancy holds while the person plays');
  const left = dormancyVerdict(pilot, { now: T, pilotHeld: false });
  ok(left.wake === true && /nobody is at the controls/.test(left.why), 'and wakes when they stop');
  ok(dormancyVerdict(pilot, { now: T, pilotHeld: true }).next_at === null, 'nothing on the clock changes a pilot wait');

  const hold = normalizeDormancy({ reason: 'operator', for_ms: 10 * M }, { now: T });
  const early = dormancyVerdict(hold, { now: T + M });
  ok(early.wake === false && early.next_at === T + 10 * M, 'an operator hold waits for its deadline and says when');
  ok(dormancyVerdict(hold, { now: T + 10 * M }).wake === true, 'and ends on it');
  const forever = normalizeDormancy({ reason: 'operator' }, { now: T });
  ok(dormancyVerdict(forever, { now: T + 100 * M }).wake === false, 'a manual hold never ends on the clock');
}

section('the penalty guard outranks every reason');
{
  // An operator logged the character off in Ukgoth and asked for an hour.
  const hold = withLogoff(normalizeDormancy({ reason: 'operator', for_ms: 60 * M, by: 'op' }, { now: T }),
                          { at: T, room: 599 });
  ok(hold.logoff.safe === false && hold.penalty.earliest === T + 540 * S, 'logged off in Ukgoth: the clock is running');
  const v = dormancyVerdict(hold, { now: T + M });
  ok(v.wake === false && v.must_wake_by === T + 540 * S - PENALTY_MARGIN_MS && v.next_at === v.must_wake_by,
     'it says how long it has, and the next moment that matters is the guard', JSON.stringify(v));
  const due = dormancyVerdict(hold, { now: T + 540 * S - PENALTY_MARGIN_MS });
  ok(due.wake === true && /logoff penalty/.test(due.why), 'and comes back before the earliest strike', due.why);
  const accepted = withLogoff(normalizeDormancy({ reason: 'operator', for_ms: 60 * M, accept_penalty: true }, { now: T }),
                              { at: T, room: 599 });
  ok(dormancyVerdict(accepted, { now: T + 590 * S }).wake === false, 'accept_penalty keeps it off anyway');
  const inn = withLogoff(normalizeDormancy({ reason: 'operator' }, { now: T }), { at: T, room: 52 });
  ok(inn.penalty === null && dormancyVerdict(inn, { now: T + 90 * M }).wake === false, 'logged off in an inn: no guard at all');
  // An evade: off for three minutes, well inside the window.
  const evade = withLogoff(normalizeDormancy({ reason: 'evade', for_ms: 3 * M }, { now: T }), { at: T, room: 599 });
  ok(dormancyVerdict(evade, { now: T + 3 * M }).wake === true, 'an evade ends on its own deadline');
}

section('the hand-over to a keeper fails closed');
{
  const rec = normalizeDormancy({ reason: 'pilot', by: 'restart-keepers' }, { now: T });
  const back = decodeDormancy(encodeDormancy(rec), { now: T });
  ok(back.reason === 'pilot' && back.wake === 'pilot_released' && back.by === 'restart-keepers', 'round-trips');
  ok(decodeDormancy('', { now: T }) === null && decodeDormancy(undefined) === null, 'no hand-over: not dormant');
  const bad = decodeDormancy('not-base64-json', { now: T });
  ok(bad?.reason === 'operator' && bad.wake === 'manual' && /unreadable/.test(bad.note),
     'garbage stays OUT, waiting to be told -- never logs in', JSON.stringify(bad));
}

section('the store');
{
  const dir = mkdtempSync(join(tmpdir(), 'dormancy-'));
  try {
    ok(dormancyFileFor('prod', dir).endsWith('dormancy-prod.json') && dormancyFileFor(null, dir).endsWith('dormancy-default.json'),
       'one file per fleet');
    const a = DormancyStore.forFleet('prod', dir), b = DormancyStore.forFleet('prod', dir);
    a.set('t20', normalizeDormancy({ reason: 'pilot', by: 'restart-keepers' }, { now: T }), T);
    ok(b.get('t20')?.reason === 'pilot', 'a record written by one process is read by another');
    ok(b.clear('t20', { why: 'nobody is at the controls any more', by: 'rejoin sweep' }, T + M) === null && !a.get('t20'),
       'clearing ends it');
    const log = a.read().log;
    ok(log.length === 2 && log[1].what === 'clear' && log[1].by === 'rejoin sweep', 'and the log says who ended it');
    ok(a.clear('t20') === null && a.read().log.length === 2, 'clearing nothing writes nothing');
    ok(DormancyStore.forFleet('shadow', dir).get('t20') === null, 'fleets do not share a store');
    // GARBAGE IS NOT "NOBODY IS HELD": read as empty it would log every held character in at once.
    writeFileSync(dormancyFileFor('broken', dir), '{ not json');
    ok(throws(() => DormancyStore.forFleet('broken', dir).all(), /unreadable/), 'an unreadable store throws, it does not read as empty');
    ok(DormancyStore.forFleet('absent', dir).get('t1') === null, 'a missing store is simply nobody held');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
