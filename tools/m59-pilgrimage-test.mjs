#!/usr/bin/env node
import {
  backgroundTravelRefusal,
  completeCycleArrival,
  dispatchDecision,
  expectedTravelPublished,
  keeperOwnsMovement,
  keeperStatusOwnsMovement,
  keeperStatusVerificationFailure,
  newPendingDispatch,
  noteDispatchResult,
  pilgrimageCycles,
} from './m59-pilgrimage-cycle.mjs';

let passed = 0, failed = 0;
function ok(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); }
}

console.log('pilgrimage mode defaults to continuous checkpoint travel');
{
  ok('an unadorned run cycles', pilgrimageCycles([]));
  ok('the historical --cycle spelling still cycles', pilgrimageCycles(['--cycle']));
  ok('--one-pass explicitly restores scatter-and-converge',
     !pilgrimageCycles(['--one-pass']));
}

console.log('a checkpoint handoff waits for the previous keeper job');
{
  const p = newPendingDispatch(2, 'cycle', 1000);
  ok('a busy previous leg blocks the next submission',
     dispatchDecision(p, { room_num: 110, busy: 'walk to A shadowy corner' }, 1000).action === 'wait');
  ok('a resumed keeper journey also blocks it',
     dispatchDecision(p, { room_num: 108, committed: { kind: 'driven' },
                           activity: 'inert — travelling to 2 (resumed)' }, 1000).action === 'wait');
  ok('recovery and resting activity block it',
     keeperOwnsMovement({ activity: 'recovering from death' }) &&
       keeperOwnsMovement({ activity: 'resting up' }));
  ok('a dormant suspended journey is caught by the detailed status gate',
     keeperStatusOwnsMovement({ activity: 'idle', suspended_journey: { to: 2 } }));
  ok('a resumed inert journey is caught by the detailed status gate',
     keeperStatusOwnsMovement({ activity: 'idle', inert: {
       state: 'travelling', why: 'travelling to 2 (resumed)',
     } }));
  ok('the Underworld never submits a handoff',
     dispatchDecision(p, { room_num: 1 }, 1000).action === 'wait');
  ok('an idle, clear keeper is ready for one submission',
     dispatchDecision(p, { room_num: 110, activity: 'idle' }, 1000).action === 'send');
  ok('a standing partner arrangement does not block pilgrimage travel',
     dispatchDecision(p, { room_num: 110, committed: {
       kind: 'partner', label: 'fighting alongside shadow02', takeable: false,
     }, activity: 'idle' }, 1000).action === 'send');
  ok('an unanswered keeper status fails verification despite its stopped shell',
     /keeper did not answer/.test(keeperStatusVerificationFailure({
       keeper_backed: true,
       note: "the keeper did not answer; the fields above describe this broker's shell",
       activity: 'stopped',
     })));
  ok('a real keeper status passes verification',
     keeperStatusVerificationFailure({ keeper_backed: true, activity: 'idle' }) === null);
}

console.log('a cycle arrival is recorded once and advances the target once');
{
  const ring = [{ room: 110 }, { room: 2 }, { room: 52 }];
  const out = { inn: 52, ring: 2, to: 110, legBegan: 1000, legs: [], deaths: 1,
                deathsAtLegStart: 0 };
  completeCycleArrival(out, ring, 4000);
  ok('the completed road and its elapsed time are recorded',
     out.legs.length === 1 && out.legs[0].from === 52 && out.legs[0].to === 110 &&
       out.legs[0].ms === 3000 && out.legs[0].deaths === 1);
  ok('the ring wraps exactly once to 110 -> 2',
     out.ring === 0 && out.legFrom === 110 && out.to === 2);
  ok('the next leg is pending rather than blindly dispatched',
     out.pendingDispatch?.to === 2 && out.pendingDispatch?.attempts === 0 &&
       out.pendingDispatch?.sent_at === null);
  ok('the old checkpoint no longer matches the new objective, preventing a double count',
     110 !== out.to);
}

console.log('an acknowledged request is not believed until the fleet sees it');
{
  const p = newPendingDispatch(2, 'cycle', 1000);
  const sent = noteDispatchResult(p, { started: true,
    destination: { num: 2, name: 'Outside Castle Victoria' } }, 2000);
  ok('the acknowledgement is remembered as unconfirmed',
     sent.attempts === 1 && sent.sent_at === 2000 && sent.retry_at === 17000 &&
       sent.expected_busy === 'walk to Outside Castle Victoria');
  ok('it is not duplicated inside the publication window',
     dispatchDecision(sent, { room_num: 110, activity: 'idle' }, 16000).action === 'wait');
  ok('a later busy snapshot confirms the new travel',
     dispatchDecision(sent, { room_num: 108, busy: 'walk to Outside Castle Victoria' }, 3000).action === 'confirmed');
  ok('an unrelated busy job does not confirm it',
     dispatchDecision(sent, { room_num: 110, busy: 'walk to Familiars' }, 3000).action === 'wait');
  ok('recovery after a masked no-start does not confirm it',
     dispatchDecision(sent, { room_num: 370, activity: 'recovering from death' }, 3000).action === 'wait');
  ok('a target-specific resumed journey does confirm it',
     expectedTravelPublished(sent, { activity: 'inert — travelling to 2 (resumed)' }));
  ok('arriving before a busy snapshot also confirms it',
     dispatchDecision(sent, { room_num: 2, activity: 'idle' }, 3000).action === 'arrived');
  ok('a masked no-start is retried after the publication window',
     dispatchDecision(sent, { room_num: 110, activity: 'idle' }, 17000).action === 'send');

  const ack = { started: true, destination: { num: 2, name: 'Outside Castle Victoria' } };
  const sent2 = noteDispatchResult(sent, ack, 17000);
  const sent3 = noteDispatchResult(sent2, ack, 32000);
  const exhausted = dispatchDecision(sent3, { room_num: 110, activity: 'idle' }, 47000);
  ok('three masked acknowledgements become an explicit failure',
     exhausted.action === 'exhausted' && /never appeared/.test(exhausted.why), exhausted.why);
}

console.log('structured refusals stay visible and retry sooner');
{
  const refusals = [
    { _error: 'already busy' }, { error: 'not in game' }, { ok: false }, { started: false }, null,
  ];
  ok('every refusal shape is recognised', refusals.every(r => backgroundTravelRefusal(r)));
  ok('takeable ownership metadata does not block a handoff',
     !keeperOwnsMovement({ committed: { kind: 'owned', takeable: true }, activity: 'idle' }));
  const p = noteDispatchResult(newPendingDispatch(2, 'death', 1000), { _error: 'already busy' }, 2000);
  ok('a visible refusal is not treated as a submitted job',
     p.sent_at === null && p.retry_at === 7000 && p.last_refusal === 'already busy');
  ok('it retries once the shorter refusal backoff expires',
     dispatchDecision(p, { room_num: 370, activity: 'idle' }, 7000).action === 'send');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
