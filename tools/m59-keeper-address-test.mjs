#!/usr/bin/env node
// A REFUSAL THAT CANNOT SAY WHAT IS WRONG. Offline: opens no socket, starts no keeper.
//
//   node tools/m59-keeper-address-test.mjs
//
// The keeper refuses any write not addressed to its exact agent/character/PID tuple, and that
// refusal is load-bearing — it is what stops a broker that lost a port from commanding whoever
// answers. But it could fail four ways and reported one, so three of them printed:
//
//     could not cancel the journey: this keeper is "t14", not "t14"
//
// Both names are "t14" because the agent MATCHED and the pid did not. Measured on prod
// 2026-09-13 during a fleet move: every character logged that sentence and no journey was
// cancelled. The old code passed `identity.agent` to the refusal and printed it against our
// own agent — equal in exactly the three cases a reader needs told apart.
//
// So these assertions are mostly about the MESSAGE, which is unusual and is the point: the
// defect was never in the predicate. `addressedToUs` was correct every time. What was broken
// was the ability to find out why.
import { addressMismatch, isAddressedTo, describeMismatch,
         presentIdentityPart, normalizedKeeperCharacter } from './m59-keeper-address.mjs';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.log('  FAIL ' + what); } };
const eq = (a, b, what) => ok(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const US = { agent: 't14', character: 'Piggy', keeperPid: 1234 };

console.log('the predicate still decides exactly as it did');
{
  ok(isAddressedTo({ agent: 't14', character: 'Piggy', keeperPid: 1234 }, US), 'the exact tuple is ours');
  ok(!isAddressedTo({ agent: 't16', character: 'Piggy', keeperPid: 1234 }, US), 'a wrong agent is not');
  ok(!isAddressedTo({ agent: 't14', character: 'Floyd', keeperPid: 1234 }, US), 'a wrong character is not');
  ok(!isAddressedTo({ agent: 't14', character: 'Piggy', keeperPid: 9999 }, US), 'a wrong pid is not');
  ok(!isAddressedTo({ agent: 't14', character: 'Piggy' }, US), 'an incomplete tuple is not');
  // A GET may be unaddressed on loopback; a write may not.
  ok(isAddressedTo({}, US, { required: false }), 'nothing claimed is allowed when not required');
  ok(!isAddressedTo({}, US), 'nothing claimed is refused for a write');
  // Types cross the wire as strings. They must still match.
  ok(isAddressedTo({ agent: 't14', character: 'Piggy', keeperPid: '1234' }, US), 'a string pid matches a number pid');
  ok(isAddressedTo({ agent: 't14', character: '  piggy  ', keeperPid: 1234 }, US), 'character compare ignores case and padding');
}

console.log('THE BUG: the refusal names the part that is actually wrong');
{
  // Agent and character both match; only the pid differs. This is the prod case, and the old
  // message rendered it as `this keeper is "t14", not "t14"`.
  const m = addressMismatch({ agent: 't14', character: 'Piggy', keeperPid: 9999 }, US);
  eq(m.part, 'keeper_pid', 'a pid-only mismatch is reported as a pid mismatch');
  const said = describeMismatch(m);
  ok(/pid/i.test(said), 'the sentence mentions the pid');
  ok(said.includes('1234') && said.includes('9999'), 'it carries BOTH pids, so they can be compared');
  // THE ASSERTION THIS FILE EXISTS FOR.
  ok(!/"t14", not "t14"/.test(said), 'it is NOT the old self-contradicting sentence');
  ok(!(said.match(/t14/g) || []).length || !/not "t14"/.test(said), 'it never says a name is not itself');
}

console.log('and the other three are each distinguishable');
{
  const agentBad = addressMismatch({ agent: 't16', character: 'Floyd', keeperPid: 1234 }, US);
  eq(agentBad.part, 'agent', 'a wrong agent says agent');
  ok(describeMismatch(agentBad).includes('t16'), 'and names the agent claimed');

  const charBad = addressMismatch({ agent: 't14', character: 'Floyd', keeperPid: 1234 }, US);
  eq(charBad.part, 'character', 'a wrong character says character');
  const cs = describeMismatch(charBad);
  ok(cs.includes('Piggy') && cs.includes('Floyd'), 'and names both characters');

  const partial = addressMismatch({ agent: 't14', character: 'Piggy' }, US);
  eq(partial.part, 'incomplete', 'a missing part says incomplete');
  ok(describeMismatch(partial).includes('keeperPid'), 'and names WHICH part is missing');

  const none = addressMismatch({}, US);
  eq(none.part, 'unaddressed', 'nothing claimed says unaddressed');

  // Four reasons, four different sentences. If any two collapse, the reader is back where
  // they started.
  const said = [agentBad, charBad, partial, none,
                addressMismatch({ agent: 't14', character: 'Piggy', keeperPid: 9999 }, US)]
    .map(describeMismatch);
  eq(new Set(said).size, 5, 'all five outcomes read differently');
}

console.log('a match reports no mismatch at all');
{
  eq(addressMismatch({ agent: 't14', character: 'Piggy', keeperPid: 1234 }, US), null, 'null means ours');
  ok(!/not/.test(describeMismatch(null)), 'and describing null does not sound like a refusal');
}

console.log('the helpers keep their original meaning');
{
  ok(presentIdentityPart(0), 'zero is present — a pid-shaped value must not read as absent');
  ok(!presentIdentityPart(''), 'an empty string is absent');
  ok(!presentIdentityPart(null) && !presentIdentityPart(undefined), 'null and undefined are absent');
  eq(normalizedKeeperCharacter('  Loial the Ogier '), 'loial the ogier', 'names normalise for comparison');
  eq(normalizedKeeperCharacter(7), null, 'a non-string character normalises to null');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
