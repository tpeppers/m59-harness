#!/usr/bin/env node
// m59-policyrevert-test.mjs — A SPOT POLICY THAT REVERTS HAS TO LEAVE A LINE.
//
//   node tools/m59-policyrevert-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster.
//
// ======================== WHAT THIS PINS ========================
//
// The broker's persistence layer logged exactly one transition — `autopilot.mode` — and
// the comment beside it says why: a silent tick->survive revert "was the undiagnosable
// part". That argument was never carried to the rest of the policy. So a push that landed
// `useSafeSpots:true, requireSafeWall:true` could be reverted to `false/false` by a later
// write and leave **no line anywhere in the broker log**, by construction.
//
// Those two flags are the ones deaths #24, #25 and #26 were root-caused to. #26 in
// particular: room 586, killed by a centipede, `in_safe_spot: false`, every trial reading
// "not holding a spot — nothing to test", pinned in the open ~18 minutes — after a re-arm
// at 01:28Z had verified both flags true. By 01:47Z the live policy read `false/false` and
// nothing could say who wrote it. The only observability that existed was the keeper's own
// `policy updated` line, which printed the incoming fields flat: a push and a revert look
// identical that way, and it named no writer at all.
//
// Three claims:
//   1. the diff covers EVERY policy field, not a watchlist — a watchlist is how `purpose`
//      stayed out of a schema for a year — but sorts the survival pair to the front;
//   2. `requireSafeWall` without `useSafeSpots` is not a legal resting value, and the
//      coercion is reported rather than applied quietly;
//   3. both broker persistence paths and the keeper's live merge log the change, the
//      keeper names the writer, and the spot pair gets the same caller trace `mode` gets.

import { readFileSync } from 'node:fs';
import { policyDiff, formatPolicyDiff, hasSpotChange, coerceSpotPair, SPOT_POLICY_KEYS }
  from './m59-policydiff.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const KEEPER = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');

// ------------------------------------------------------------------ 1. the diff

console.log('\nthe revert that used to be invisible');
{
  const armed   = { useSafeSpots: true,  requireSafeWall: true,  hunt: 'giant rat', fleeBelow: 0.7 };
  const spotless = { useSafeSpots: false, requireSafeWall: false, hunt: 'giant rat', fleeBelow: 0.7 };

  const rows = policyDiff(armed, spotless);
  ok('THE BUG: the exact 01:28Z -> 01:47Z revert produces two rows', rows.length === 2);
  ok('and it reads as a revert rather than as a fresh push, because both values are there',
     formatPolicyDiff(rows) === 'useSafeSpots true -> false, requireSafeWall true -> false',
     formatPolicyDiff(rows));
  ok('and the survival pair is flagged, so a caller can treat it differently',
     rows.every(r => r.survival) && hasSpotChange(rows));
  ok('nothing that did not change is reported', !rows.some(r => r.key === 'hunt'));
  ok('an identical policy is silence, not an empty line',
     policyDiff(armed, { ...armed }).length === 0);
}

console.log('\nevery field, because a watchlist is the same mistake one field later');
{
  const rows = policyDiff({ fightAboveVigor: 180, purpose: null },
                          { fightAboveVigor: 80,  purpose: 'apothecary run' });
  ok('a threshold change is reported', rows.some(r => r.key === 'fightAboveVigor'));
  ok('and so is `purpose`, the field whose absence switched every audit off for a year',
     rows.some(r => r.key === 'purpose'));
  ok('the survival pair sorts first even when other fields changed',
     policyDiff({ a: 1, useSafeSpots: true }, { a: 2, useSafeSpots: false })[0].key === 'useSafeSpots');
  ok('a key that disappears is a change, not a silence — that is what a revert looks like',
     formatPolicyDiff(policyDiff({ requireSafeWall: true }, {})) === 'requireSafeWall true -> (unset)');
  ok('a key that appears is one too',
     formatPolicyDiff(policyDiff({}, { requireSafeWall: true })) === 'requireSafeWall (unset) -> true');
  ok('an object field is compared by value rather than by reference',
     policyDiff({ farmDelivery: { enabled: true } }, { farmDelivery: { enabled: true } }).length === 0);
  ok('and a real change inside one is caught',
     policyDiff({ farmDelivery: { enabled: true } }, { farmDelivery: null }).length === 1);
  ok('a long value is summarised rather than dropped',
     /farmDelivery .*-> null/.test(formatPolicyDiff(
       policyDiff({ farmDelivery: { enabled: true, radius: 4, requested: { herb: 30 } } },
                  { farmDelivery: null }))));
  ok('missing policies on both sides are not a crash', policyDiff(null, undefined).length === 0);
  ok('there are exactly two survival keys, and they are the pair',
     SPOT_POLICY_KEYS.join(',') === 'useSafeSpots,requireSafeWall');
}

// ------------------------------------------------------------------ 2. the invariant

console.log('\nrequire-a-wall while not looking for one is not a resting value');
{
  const p = { useSafeSpots: false, requireSafeWall: true };
  const changed = coerceSpotPair(p);
  ok('THE PARTIAL STATE IS COERCED', p.useSafeSpots === true && p.requireSafeWall === true);
  ok('and it is reported, so the caller learns what it actually got',
     changed.length === 1 && changed[0].key === 'useSafeSpots' && changed[0].to === true);
  ok('with the reason, because a silently rewritten argument is the bug next door',
     /meaningless with spots off/.test(changed[0].why));

  // COERCED UP, NEVER DOWN. Clearing requireSafeWall instead would answer a request for
  // more caution by removing it — on the exact pair that has killed three characters.
  const q = { useSafeSpots: false, requireSafeWall: true };
  coerceSpotPair(q);
  ok('the stricter flag is the one that survives', q.requireSafeWall === true);

  // The other three combinations are all meaningful and must be left alone.
  for (const [spots, wall] of [[false, false], [true, false], [true, true]]) {
    const r = { useSafeSpots: spots, requireSafeWall: wall };
    ok(`${spots}/${wall} is a legal setting and is left alone`,
       coerceSpotPair(r).length === 0 && r.useSafeSpots === spots && r.requireSafeWall === wall);
  }
  ok('a policy that mentions neither flag is untouched',
     coerceSpotPair({ hunt: 'giant rat' }).length === 0);
  ok('and a missing policy is not a crash', coerceSpotPair(null).length === 0);
}

// ------------------------------------------------------------------ 3. the wiring

console.log('\nboth broker persistence paths now say what changed');
{
  ok('saveFleetState diffs the policy, not only the mode',
     /const rows = policyDiff\(now\[agent\]\.autopilot\.policy, entry\.autopilot\.policy\);/.test(BROKER));
  ok('and prints it beside the mode line it was modelled on',
     /\[state\] \$\{agent\} policy \$\{formatPolicyDiff\(rows\)\} \(saveFleetState\)/.test(BROKER));
  // A resume carries entries forward from disk that this process never loaded. Diffing
  // those would be twenty-one lines of "policy unset" about nothing having happened.
  ok('but only for agents both sides actually have orders for',
     /if \(now\[agent\]\?\.autopilot && entry\.autopilot\) \{/.test(BROKER));

  ok('rememberAutopilot diffs it too',
     /const changed = policyDiff\(e\.autopilot\?\.policy, config\.policy\);/.test(BROKER));
  ok('and the survival pair gets the same caller trace the mode write has always got',
     /hasSpotChange\(changed\) \? '\\n' \+ callerTrace\('spot-policy trace'\)/.test(BROKER));
  ok('which is one helper rather than two copies of the magic slice numbers',
     /const callerTrace = \(label\) =>/.test(BROKER) &&
     /callerTrace\('mode-change trace'\)/.test(BROKER));

  ok('the invariant runs before the roster write',
     /for \(const c of coerceSpotPair\(config\.policy\)\)/.test(BROKER));
  ok('and before the push, so the roster and the keeper cannot disagree about it',
     /const coerced = coerceSpotPair\(p\.policy\);[\s\S]{0,400}rememberAutopilot\(a\.agent/.test(BROKER));
  ok('and the autopilot tool reports the coercion back to its caller',
     /if \(coerced\.length\) out\.coerced = coerced;/.test(BROKER));
}

console.log('\nand the keeper says what it was, and who asked');
{
  ok('the writer rides on the wire as a reserved key',
     /body\.by = `broker pid \$\{process\.pid\} fleet \$\{FLEET \?\? 'default'\}`;/.test(BROKER));
  ok('the keeper strips it rather than applying it as a policy field',
     /const \{ agent: _addressed, mode: wantMode, by: writtenBy, \.\.\.fields \} = body;/.test(KEEPER));
  ok('and says so in the comment that already lists the reserved keys',
     /THREE RESERVED KEYS/.test(KEEPER));
  ok('the live policy is captured before the merge, or there is nothing to diff against',
     /const before = \{ \.\.\.autopilot\.policy \};\n {8}Object\.assign\(autopilot\.policy, fields\);/.test(KEEPER));
  ok('the log line carries before -> after rather than the incoming fields flat',
     /policy updated: ` \+\n {12}\(rows\.length \? formatPolicyDiff\(rows\) : 'no field changed value'\)/.test(KEEPER));
  ok('and names the writer', /by \$\{writtenBy \?\? 'unattributed/.test(KEEPER));
  // A push that changes nothing is worth saying out loud: it is what a no-op re-push looks
  // like, and reading it as a successful change is how a revert gets blamed on the wrong line.
  ok('a push that moved no value says that rather than printing an empty diff',
     /'no field changed value'/.test(KEEPER));
  ok('the keeper enforces the pairing invariant on whatever it is handed',
     /const coercedSpots = coerceSpotPair\(fields\);/.test(KEEPER));
  ok('and rides the coercion back in the reply beside `applied`',
     /\.\.\.\(coercedSpots\.length \? \{ coerced: coercedSpots \} : \{\}\),/.test(KEEPER));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
