#!/usr/bin/env node
// AN UNARMED CHARACTER LEAVING A SPAWN ROOM, AND THE GATE IT COULD NEVER SATISFY.
// Offline: no broker, no socket, no roster, no fleet.
//
// `passArm`'s unarmed branch called `townTripIfCornered()`, whose THIRD LINE is
// `if ((this.fledInARow || 0) <= 2) return false;`. `fledInARow` is incremented in exactly
// ONE place in the whole file — `gotOut()` inside `passFleeAndRest`, after a successful
// `leaveViaAny`. It counts successful FLEES. Being unarmed is not fleeing and never touches
// that counter, so the caller asked a question whose precondition it could never meet and was
// refused SILENTLY, on every pass, for ever.
//
// Measured on prod 2026-09-19: Beaker 1,850 consecutive repeats of that note and Animal 1,100,
// both bare-handed with a spider ONE SQUARE away and `went_to_town: false` every time. The
// boolean was the only output and could not say which of three things had happened.
//
// The gate is NOT widened: three flees in a row is the escalation ladder for the original
// caller, which also resets the counter on success. This path wants the other half of that
// function — "where is the nearest place I can sit down safely" — which was already extracted.
import { Autopilot } from './m59-autopilot.mjs';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

const rig = ({ sanctuary = { room: 106, hops: 2, preferred: true }, arrives = true,
               reason = 'no route', fledInARow = 0, backoffUntil = null } = {}) => {
  const calls = { nearest: 0, travelled: [], notes: [], progress: [], noProgress: [], hibernate: 0 };
  const self = {
    fledInARow, noUnarmedRefugeUntil: backoffUntil,
    s: { client: { vitals: () => ({ mana: { value: 4 } }) } },
    nearestSanctuary() { calls.nearest++; return sanctuary; },
    async travel(room) { calls.travelled.push(room); return arrives ? { arrived: true } : { arrived: false, reason }; },
    note(what, data) { calls.notes.push({ what, ...data }); },
    progress(w) { calls.progress.push(w); },
    noProgress(w) { calls.noProgress.push(w); },
    async hibernate() { calls.hibernate++; return true; },
  };
  return { self, calls };
};
const call = (self) => Autopilot.prototype.leaveForManaWhileUnarmed.call(self);

console.log('--- THE DEFECT: never fled, so the old gate refused for ever ---');
{
  const { self, calls } = rig({ fledInARow: 0 });
  const r = await call(self);
  ok('acts with fledInARow = 0', r === true, 'travelled to ' + calls.travelled.join(','));
  ok('walks to the sanctuary it found', calls.travelled.length === 1 && calls.travelled[0] === 106);
  ok('reports progress and hibernates', calls.progress.length === 1 && calls.hibernate === 1);
  ok('the note says it arrived', calls.notes[0]?.outcome === 'arrived', String(calls.notes[0]?.outcome));
}

console.log('\n--- and it leaves the FLEE LADDER alone, in both directions ---');
{
  const { self } = rig({ fledInARow: 2 });
  await call(self);
  ok('does not reset fledInARow on success', self.fledInARow === 2,
     'townTripIfCornered clears it; sharing that state between the two callers is the tidy-up to refuse');
}

console.log('\n--- the three outcomes are DISTINGUISHABLE, which is the whole point ---');
const outcomes = new Set();
{
  const { self, calls } = rig({ sanctuary: null });
  const r = await call(self);
  outcomes.add(calls.notes[0]?.outcome);
  ok('no sanctuary within three hops names itself',
     calls.notes[0]?.outcome === 'no_sanctuary_within_3_hops', String(calls.notes[0]?.outcome));
  ok('and backs the SEARCH off rather than flooding every pass', self.noUnarmedRefugeUntil > Date.now());
  ok('returns false and reports NO progress', r === false && calls.noProgress.length === 1);
}
{
  const { self, calls } = rig({ arrives: false, reason: 'no route' });
  const r = await call(self);
  outcomes.add(String(calls.notes[0]?.outcome).split(':')[0]);
  ok('a failed WALK names itself and carries the reason',
     /^travel_failed: no route/.test(String(calls.notes[0]?.outcome)), String(calls.notes[0]?.outcome));
  // The second silent gate in townTripIfCornered is `noTownUntil`; bypassing the flee
  // counter skips that backoff too, and without one here a reachable-but-blocked refuge
  // is re-planned every pass — a loop of failed walks, which looks healthier than a
  // silent refusal and is worse in the room.
  ok('and backs off, so it does not re-plan the same walk every pass',
     self.noUnarmedRefugeUntil > Date.now());
  ok('returns false and reports NO progress', r === false && calls.noProgress.length === 1);
}
{
  const { self, calls } = rig({ backoffUntil: Date.now() + 60_000 });
  const r = await call(self);
  outcomes.add(calls.notes[0]?.outcome);
  ok('a rate-limited pass names itself too', calls.notes[0]?.outcome === 'search_rate_limited');
  ok('and does NOT run the sanctuary flood while backed off', calls.nearest === 0);
  ok('returns false', r === false);
}
ok('all three failure outcomes are different strings', outcomes.size === 3,
   [...outcomes].join(' | '));

console.log('\n--- a refusal is never reported as progress ---');
{
  const { self, calls } = rig({ sanctuary: null });
  await call(self);
  ok('noProgress, not progress — a body that moved nowhere stays visible to stall detection',
     calls.progress.length === 0 && calls.noProgress.length === 1,
     'this is the retreat_to_inn mistake: five callers reported progress for a retreat that moved nobody');
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
