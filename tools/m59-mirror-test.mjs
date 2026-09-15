#!/usr/bin/env node
// Offline. Opens no socket, reads no roster, needs no server: every input is a string of
// the shape the maintenance socket returns.
//
// The bug this exists for, 2026-09-11. `plSkills` holds one integer per ability and the
// SIGN is a flag — `EncodeSkill` (player.kod:7254) returns `num*100 + iability` when the
// ability has been used since it last advanced and `-(num*100 + iability)` when it has not.
// The decoder matched `/INT (\d+)/`, which does not match a leading minus, so a list of ten
// skills decoded as `{}`. Everything followed from that one regex: the mirror concluded
// every character had no abilities, emitted `AddSkill` for ones they already had, the
// server refused each (AddSkill returns FALSE when HasSkill), the run reported those as
// "could not grant", and a plain read of the fleet said twenty of twenty-one characters had
// lost every skill. Nothing had been lost, and one of the "fixes" reasoned from that report
// sent deltas computed against zero, which inflated real abilities to the 99 cap.
//
// A decoder is the cheapest thing in this file to test and was the most expensive thing to
// get wrong, because every conclusion drawn downstream of it looked like a different bug.

import assert from 'node:assert/strict';
import { decodeAbilityList, decodeAbilityUse, abilityNumbers } from './m59-mirror.mjs';

let checks = 0;
const is = (actual, expected, what) => { checks++; assert.deepEqual(actual, expected, what); };

// A real reply, as `show list <id>` returns it.
const LIST = `> show list 86901
:<
: [
: INT -45114
: INT -45515
: INT -43044
: INT 42199
: INT -40498
: INT -45012
: ]
:>`;

// ---- THE SIGN IS A FLAG, NOT A MINUS.
is(decodeAbilityList(LIST), {
  451: 14, 455: 15, 430: 44, 421: 99, 404: 98, 450: 12,
}, 'an unused ability is stored negative and is still an ability');

is(decodeAbilityUse(LIST), {
  451: false, 455: false, 430: false, 421: true, 404: false, 450: false,
}, 'and the sign is readable on its own, because a mirror must not flip it');

// The exact regression: brawling at 12%, stored negative, is present.
checks++;
assert.equal(decodeAbilityList(LIST)[450], 12, 'brawling 12% — the ability the mirror kept trying to add');
checks++;
assert.equal(Object.hasOwn(decodeAbilityList(LIST), 450), true, 'and `present` must be true for it');

// ---- an empty list is empty, and an absent one is too
is(decodeAbilityList('> show list 1\n:<\n: [\n: ]\n:>'), {}, 'an empty list decodes to nothing');
is(decodeAbilityList(''), {}, 'no reply at all decodes to nothing');
is(decodeAbilityList('plSkills = $ 0'), {}, 'an unset property decodes to nothing');

// ---- ability 0 is a value, not an absence: a skill at 0% is still held, and the mirror
// must send a CHANGE for it rather than an ADD the server will refuse.
is(decodeAbilityList(': INT -45000'), { 450: 0 }, 'a held ability at 0% is held');
checks++;
assert.equal(Object.hasOwn(decodeAbilityList(': INT -45000'), 450), true, 'and is present');

// ---- nothing that is not an ability may become one
is(decodeAbilityList(': INT 0\n: INT 99\n: INT -7'), {},
   'values below 100 encode no ability number and are not invented into one');

// ---- names to the LOCAL server's numbers, from the kod it was built from
{
  const N = abilityNumbers();
  checks++;
  assert.equal(N.skills['brawling'], 450, 'brawling is SKID_BRAWLING');
  checks++;
  assert.equal(N.skills['block'], 404, 'block is SKID_BLOCK');
  checks++;
  assert.equal(N.skills['slash'], 421, 'slash is SKID_SLASH — declared viSkill_Num, capital N');
  checks++;
  assert.equal(N.spells['blink'], 32, 'blink is SID_BLINK');
  checks++;
  assert.ok(!Number.isFinite(N.skills['3739']), 'an object id is not an ability number');
}

console.log(`m59-mirror: PASS (${checks} checks)`);
